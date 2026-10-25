import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

import { parse } from "yaml";

/**
 * Holds where the release workflow's secrets may be read. Any step of a job
 * can read every secret the job references, and the source's install, tests
 * and build run third-party code, so each secret is kept to the jobs that
 * need it, and the deploy key out of every job that runs that code.
 */
const workflows = new URL("../.github/workflows/", import.meta.url);
const read = async (name) =>
  parse(await readFile(new URL(name, workflows), "utf8"));
const release = await read("release.yml");
const jobs = Object.entries(release.jobs);

/** Each string anywhere in a value, with the path to it. */
function* strings(value, path = []) {
  if (typeof value === "string") {
    yield [value, path];
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      yield* strings(child, [...path, key]);
    }
  }
}

/** The names of the secrets a value refers to, with the path to each. */
function* secretReferences(value) {
  for (const [text, path] of strings(value)) {
    for (const [expression] of text.matchAll(/\$\{\{[^}]*\}\}/g)) {
      for (const word of expression.matchAll(/\bsecrets\b(\.\w+)?/g)) {
        // `secrets[...]` or `toJSON(secrets)` would hand on secrets this test
        // cannot name.
        assert.ok(
          word[1],
          `${path.join(".")} refers to secrets without naming one`,
        );
        yield [word[1].slice(1), path];
      }
    }
  }
}

const secretsOf = (job) =>
  new Set([...secretReferences(job)].map(([name]) => name));
const jobsReferring = (name) =>
  jobs.filter(([, job]) => secretsOf(job).has(name));
const namesOf = (holders) => holders.map(([name]) => name).sort();
const runsNode = (step) =>
  /^(pnpm|actions)\/(action-setup|setup-node)@/.test(step.uses ?? "") ||
  /\b(pnpm|npm|npx|node|corepack|yarn)\b/.test(step.run ?? "");

describe("the release workflow", () => {
  it("starts on a version tag only", () => {
    assert.deepEqual(release.on, { push: { tags: ["v*"] } });
  });

  it("refers to secrets only in a step", () => {
    assert.deepEqual([...secretReferences({ ...release, jobs: {} })], []);
    for (const [name, job] of jobs) {
      const { steps, ...rest } = job;
      assert.deepEqual(
        [...secretReferences(rest)],
        [],
        `job ${name} refers to a secret outside its steps`,
      );
      assert.ok(
        !JSON.stringify(job).includes("secrets: inherit"),
        `job ${name} inherits secrets`,
      );
    }
  });

  it("refers to the deploy key and the archive key, and no other secret", () => {
    assert.deepEqual(
      [...secretsOf(release)].sort(),
      ["SOURCE_ARCHIVE_KEY", "SOURCE_DEPLOY_KEY"],
    );
  });

  it("holds every secret in the release environment", () => {
    for (const [name, job] of jobs) {
      if (secretsOf(job).size > 0) {
        assert.equal(
          job.environment,
          "release",
          `job ${name} refers to a secret outside the release environment`,
        );
      }
    }
  });

  it("fetches the source in a job that runs no Node and seals what it hands on", () => {
    const holders = jobsReferring("SOURCE_DEPLOY_KEY");
    assert.deepEqual(
      namesOf(holders),
      ["fetch"],
      "the deploy key is held by the fetch job alone",
    );
    const [[name, job]] = holders;
    for (const step of job.steps) {
      assert.ok(
        !runsNode(step),
        `job ${name} holds the deploy key and runs Node in ${step.name ?? step.uses}`,
      );
      if (/^actions\/upload-artifact@/.test(step.uses ?? "")) {
        assert.match(
          step.with.path,
          /\.enc$/,
          `job ${name} uploads something it has not sealed`,
        );
      }
    }
    const steps = job.steps.filter((step) =>
      secretsOf(step).has("SOURCE_DEPLOY_KEY"),
    );
    assert.equal(steps.length, 1);
    assert.match(steps[0].uses, /^actions\/checkout@/);
    assert.equal(steps[0].with["persist-credentials"], false);
  });

  it("hands the archive key to steps that run no Node, in their env", () => {
    const holders = jobsReferring("SOURCE_ARCHIVE_KEY");
    assert.deepEqual(
      namesOf(holders),
      ["build", "fetch"],
      "the archive key is held by the fetch and build jobs alone",
    );
    for (const [name, job] of holders) {
      for (const [secret, [index, ...path]] of secretReferences(job.steps)) {
        if (secret !== "SOURCE_ARCHIVE_KEY") continue;
        assert.deepEqual(
          path,
          ["env", "SOURCE_ARCHIVE_KEY"],
          `job ${name} hands the archive key on other than in a step's env`,
        );
        assert.ok(
          !runsNode(job.steps[Number(index)]),
          `job ${name} hands the archive key to a step that runs Node`,
        );
      }
    }
  });

  it("attests and publishes in a job that holds no secret", () => {
    for (const [name, job] of jobs) {
      const publishes = ["id-token", "attestations", "contents"].some(
        (permission) => job.permissions?.[permission] === "write",
      );
      if (publishes) {
        assert.deepEqual(
          [...secretsOf(job)],
          [],
          `job ${name} may publish and holds a secret`,
        );
        assert.equal(
          job.environment,
          undefined,
          `job ${name} may publish and runs in an environment`,
        );
      }
    }
  });

  it("deletes the run's artifacts in a job that runs nothing of the source", () => {
    const deleters = jobs.filter(
      ([, job]) => job.permissions?.actions === "write",
    );
    assert.equal(deleters.length, 1);
    const [[name, job]] = deleters;
    assert.equal(
      job.if,
      "always()",
      `job ${name} skips its cleanup when the run fails`,
    );
    assert.deepEqual(
      [...job.needs].sort(),
      jobs
        .map(([other]) => other)
        .filter((other) => other !== name)
        .sort(),
      `job ${name} may run before every other job has ended`,
    );
    assert.deepEqual([...secretsOf(job)], []);
    assert.ok(
      job.steps.every((step) => step.uses === undefined && !runsNode(step)),
    );
  });

  it("sets every job's permissions", () => {
    assert.deepEqual(release.permissions, { contents: "read" });
    for (const [name, job] of jobs) {
      assert.ok(
        job.permissions,
        `job ${name} takes the workflow's permissions`,
      );
    }
  });
});

describe("every workflow", async () => {
  const names = (await readdir(workflows)).filter((name) =>
    /\.ya?ml$/.test(name),
  );

  for (const name of names) {
    const workflow = await read(name);

    it(`${name} pins each action by its full commit id`, () => {
      for (const [text, path] of strings(workflow)) {
        if (path.at(-1) === "uses") {
          assert.match(
            text,
            /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
            `${name}: ${path.join(".")}`,
          );
        }
      }
    });

    if (name !== "release.yml") {
      it(`${name} refers to no secret`, () => {
        assert.deepEqual([...secretReferences(workflow)], []);
      });
    }
  }
});
