import test from "node:test";
import assert from "node:assert/strict";
import {
  decodePrimaryAddress, deriveSubaddress, viewKeyMatches,
} from "../src/monero-address.js";

// From monero-ts 0.11.20 (the reference wallet's code compiled to wasm), for
// two throwaway wallets whose spend keys were discarded.
const vectors = [
  {
    network: "mainnet",
    primary: "44ZSdpMPz8hNot7sLZfifG6A17W4n9EGHfTbQAobkg4EgQ6XcebTXxpNKT6tMAFcu66kdH4pYQFb6AiTYMX7F1fVMz8uSUp",
    viewKey: "0077083a219c33bbef6a65e9de4a54b71d243db35be2861221936d389a95610c",
    subaddresses: [
      [0, 1, "84EjAHAk7a3Cmb9esW5K3zN6f5h4MTfrLBUezDKppCSMfHZt28Nxtvk66Saa9HR7HKKjxQUWSC3UoAmBgtBnoqUkQ7wn8GZ"],
      [1, 1, "856XkGHHRceAvKeaqTmZSxFKGWyuKgcrS2KDJntac13b8U8h5HZzMz69FZDXTyRvrqPvLTGn7xJLeBMvVoGFLtfaTBYT1sr"],
      [1, 5, "83nbTW2ZNveDSk43pAxtdE2xTgo71A9cGFY8LRFSCdchTBwvvQhWgQLHMZfq3CRJGvC13q32AEWF2eWpGMbcABCxSQM9Fx9"],
      [3, 200, "8B59io5syLSMwXta2WmWrvNGPmNDKQTnUKjaXiQByhh6YR2Z3mu1KyXKQD9AXd7qL1dstCK7EwoznKSJfoAYeq8ZTKz7WUN"],
      [49, 12345, "8BauCqLnz65N91uy4KHArnBhAMWt9BhzAeH6zxDtBQjW35gTnjB1MMbHtgs3m3qkz33ykwNYLSRzQMP7brLdoFM8E1LrYaY"],
    ],
  },
  {
    network: "stagenet",
    primary: "5AUnubSxNrKNcaKrNGpDK66XM2d7H5wR963yVx5Ps6aKSbUVYZTxWD1AqqBYDDd3DiaNKt42RZNaZGTGv3cwtxV6Q8mzane",
    viewKey: "a5ce85c7c6d283a529172b0c25938330c703e5c6590dfe9c5a0ccc145e087b02",
    subaddresses: [
      [0, 1, "77gDrfRr3kMirrAbio9ZpiCq2x5NQ97rkcZoxfBUkKdohV7wLuAFr3oXMUjCz8HA3zRJUGHT9cbPr1sdiSAuPkhN78yc1nY"],
      [1, 1, "78VE3oYkw34PwFvLepuvtnFzKg3hLTRJQVWaqXJt4xug1z6zJ3H63PEjhewEZsfknL4RiYfsqYNsVQM1i3GyJ6Z14dAQkGR"],
      [1, 5, "7BphSzMDW9dbzgs3cmE21nJaQuzvDbjGtLctkmti24CB9xXN44o5fum5Hp2zcQPovkUNQwbnKPemj166cYrrRD3w1s2KpXS"],
      [3, 200, "767My9E1Und3YCMHZgytTr5mRJLTCHX1pANE48Ct9sqXci5CynT2BNxGf11wV2zC6vc4463maAYEL8ysSxH6cQV3T6XGoyL"],
      [49, 12345, "7BmrguCSZYnAD7Wcx8qKWBFx8r14W4jzeDgz6ZuCyUkS6s3jLNJ2nGaZGE4Gygrg3dDAsiKq7XBB8C5WTcWbiknHVPoMBm4"],
    ],
  },
] as const;

test("subaddresses match the reference wallet", () => {
  for (const vector of vectors) {
    const primary = decodePrimaryAddress(vector.primary, vector.network);
    assert.ok(primary, vector.network);
    assert.ok(viewKeyMatches(primary, vector.viewKey));
    for (const [account, index, expected] of vector.subaddresses) {
      assert.equal(
        deriveSubaddress(primary, vector.viewKey, account, index, vector.network),
        expected, `${vector.network} ${account}/${index}`,
      );
    }
  }
});

test("addresses and view keys are checked", () => {
  const [mainnet, stagenet] = vectors;
  assert.equal(decodePrimaryAddress(mainnet.primary, "stagenet"), undefined);
  assert.equal(decodePrimaryAddress(stagenet.subaddresses[0][2], "stagenet"), undefined);
  const typo = stagenet.primary.slice(0, 40) +
    (stagenet.primary[40] === "a" ? "b" : "a") + stagenet.primary.slice(41);
  assert.equal(decodePrimaryAddress(typo, "stagenet"), undefined);
  const primary = decodePrimaryAddress(stagenet.primary, "stagenet")!;
  assert.equal(viewKeyMatches(primary, mainnet.viewKey), false);
  assert.throws(() => deriveSubaddress(primary, stagenet.viewKey, 0, 0, "stagenet"));
});
