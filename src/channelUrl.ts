import { Protobuf } from "@meshtastic/core";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

const URL_PREFIX = "https://meshtastic.org/e/#";

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Parses a Meshtastic channel URL (https://meshtastic.org/e/#<b64url>).
// Also accepts just the base64url fragment.
export function parseChannelSetUrl(
  url: string,
): Protobuf.AppOnly.ChannelSet {
  const frag = url.includes("#") ? url.slice(url.indexOf("#") + 1) : url.trim();
  if (!frag) throw new Error("URL vacía");
  const set = fromBinary(Protobuf.AppOnly.ChannelSetSchema, b64urlToBytes(frag));
  if (!set.settings.length) throw new Error("La URL no contiene canales");
  return set;
}

// Builds the shareable URL from the channel settings + LoRa config.
export function buildChannelSetUrl(
  settings: Protobuf.Channel.ChannelSettings[],
  loraConfig?: Protobuf.Config.Config_LoRaConfig,
): string {
  if (!settings.length) throw new Error("Sin canales para exportar");
  const set = create(Protobuf.AppOnly.ChannelSetSchema, { settings, loraConfig });
  const bytes = toBinary(Protobuf.AppOnly.ChannelSetSchema, set);
  return URL_PREFIX + bytesToB64url(bytes);
}
