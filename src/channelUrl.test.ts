// Self-check: node --experimental-strip-types src/channelUrl.test.ts
import assert from "node:assert";
import { create, toBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import {
  b64urlToBytes,
  buildChannelSetUrl,
  parseChannelSetUrl,
} from "./channelUrl.ts";

// Vector generated with the same schema → tests decode + protobuf wiring.
const set = create(Protobuf.AppOnly.ChannelSetSchema, {
  settings: [
    { name: "Principal", psk: new Uint8Array([1]) },
    { name: "Privado", psk: new Uint8Array([9, 8, 7]) },
  ],
  loraConfig: { region: 3, modemPreset: 0 },
});
const bytes = toBinary(Protobuf.AppOnly.ChannelSetSchema, set);
// base64url WITHOUT padding, like real Meshtastic URLs
const b64url = Buffer.from(bytes)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

// atob is used in b64urlToBytes; missing in node <20 but present in 22
const parsed = parseChannelSetUrl(`https://meshtastic.org/e/#${b64url}`);
assert.equal(parsed.settings.length, 2, "nº canales");
assert.equal(parsed.settings[0].name, "Principal");
assert.equal(parsed.settings[1].name, "Privado");
assert.deepEqual(parsed.settings[1].psk, new Uint8Array([9, 8, 7]), "PSK");
assert.equal(parsed.loraConfig?.region, 3, "región LoRa");

// accepts the fragment alone
assert.equal(parseChannelSetUrl(b64url).settings.length, 2, "sin prefijo URL");

// padding: lengths requiring 1, 2 and 3 filler bytes
for (const raw of ["AQ", "AQI", "AQID"]) {
  assert.doesNotThrow(() => b64urlToBytes(raw), `padding ${raw}`);
}

// empty blows up
assert.throws(() => parseChannelSetUrl("https://x/e/#"), /vacía/);

// roundtrip export → import: the generated URL parses back identically
const url = buildChannelSetUrl(set.settings, set.loraConfig);
assert.ok(url.startsWith("https://meshtastic.org/e/#"), "prefijo URL");
const back = parseChannelSetUrl(url);
assert.equal(back.settings.length, 2, "roundtrip nº");
assert.equal(back.settings[0].name, "Principal", "roundtrip nombre");
assert.deepEqual(back.settings[1].psk, new Uint8Array([9, 8, 7]), "roundtrip PSK");
assert.equal(back.loraConfig?.region, 3, "roundtrip región");
assert.throws(() => buildChannelSetUrl([]), /Sin canales/);

console.log("channelUrl OK");
