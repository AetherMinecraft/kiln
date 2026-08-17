import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const legacySource = "https://github.com/kiln-site/hearth"

test("published Hearth and Relay images retain the legacy source label", async () => {
  const [
    reusableImage,
    images,
    nightlyRelease,
    hearthDockerfile,
    relayDockerfile,
  ] = await Promise.all([
    readFile(".github/workflows/reusable-image.yml", "utf8"),
    readFile(".github/workflows/images.yml", "utf8"),
    readFile(".github/workflows/nightly-release.yml", "utf8"),
    readFile("apps/web/Dockerfile", "utf8"),
    readFile("apps/relay/Dockerfile", "utf8"),
  ])

  assert.match(
    reusableImage,
    /labels: \|\n\s+\$\{\{ inputs\.source_label && format\('org\.opencontainers\.image\.source=\{0\}', inputs\.source_label\) \|\| '' \}\}/u
  )
  assert.equal(countSourcePins(images), 1)
  assert.equal(countSourcePins(nightlyRelease), 3)
  assert.doesNotMatch(
    images,
    /source_label: https:\/\/github\.com\/kiln-site\/kiln/u
  )
  assert.doesNotMatch(
    nightlyRelease,
    /source_label: https:\/\/github\.com\/kiln-site\/kiln/u
  )
  assert.match(hearthDockerfile, dockerfileSourceLabel())
  assert.match(relayDockerfile, dockerfileSourceLabel())
})

function countSourcePins(workflow) {
  return workflow.split(`source_label: ${legacySource}`).length - 1
}

function dockerfileSourceLabel() {
  return new RegExp(
    `LABEL org\\.opencontainers\\.image\\.source="${legacySource}"`,
    "u"
  )
}
