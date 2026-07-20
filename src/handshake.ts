import { Types } from "@meshtastic/core";

/** Just what waitConfigured needs, so it can be tested without a radio. */
export interface StatusSource {
  events: {
    onDeviceStatus: {
      subscribe(fn: (status: Types.DeviceStatusEnum) => void): () => void;
    };
  };
}

/** Waits for the handshake to actually finish.
 *
 *  configure() only writes the wantConfigId and resolves; it never waits for
 *  the reply. Without this, a half-open link —Windows keeps the GATT session
 *  cached for a few seconds after the node reboots, which is exactly what
 *  applying a config does— counts as a successful connection: the
 *  auto-reconnect stops retrying and the app sits in DeviceConfiguring
 *  forever without receiving a thing.
 *
 *  Subscribe BEFORE calling configure(): the reply can arrive first. */
export function waitConfigured(d: StatusSource, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let off: (() => void) | undefined;
    const done = (err?: Error) => {
      clearTimeout(timer);
      off?.();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => done(new Error("la radio no completó la configuración")),
      ms,
    );
    off = d.events.onDeviceStatus.subscribe((st) => {
      if (st === Types.DeviceStatusEnum.DeviceConfigured) done();
      else if (st === Types.DeviceStatusEnum.DeviceDisconnected) {
        done(new Error("enlace perdido durante la configuración"));
      }
    });
  });
}
