import { Protobuf, Types } from "@meshtastic/core";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
// explicit extension so the Node harness can import this module
import { makeTransport } from "./bridge.ts";

/**
 * Simulated radio: it speaks the same byte protocol as a real one, so it
 * exercises the whole stack (framing, protobuf, events, SQLite writes) without
 * hardware. It covers what depends on having neighbors or on someone replying:
 * traceroutes, NeighborInfo, route changes, acks.
 *
 * It doesn't try to imitate the firmware: it only emits enough for the app to
 * behave as it does on a real mesh.
 */

const MI_NUM = 0x7f000001;

interface NodoSim {
  num: number;
  longName: string;
  shortName: string;
  hops: number;
  lat: number;
  lon: number;
  bateria: number;
}

const NODOS: NodoSim[] = [
  { num: 0x7f00a001, longName: "Repetidor Cim", shortName: "CIM", hops: 0, lat: 39.71, lon: 2.79, bateria: 88 },
  { num: 0x7f00a002, longName: "Nodo Puerto", shortName: "PORT", hops: 1, lat: 39.57, lon: 2.65, bateria: 46 },
  { num: 0x7f00a003, longName: "Base Sierra", shortName: "SIER", hops: 2, lat: 39.82, lon: 2.51, bateria: 71 },
  { num: 0x7f00a004, longName: "Movil Furgo", shortName: "FURG", hops: 2, lat: 39.62, lon: 2.9, bateria: 23 },
  { num: 0x7f00a005, longName: "Solar Valle", shortName: "VALL", hops: 3, lat: 39.9, lon: 2.7, bateria: 95 },
];

const enc = new TextEncoder();
const marco = (payload: Uint8Array) =>
  new Uint8Array([148, 195, (payload.length >> 8) & 255, payload.length & 255, ...payload]);

let idSeq = 1;
const nextId = () => idSeq++;

export async function createFakeTransport(): Promise<Types.Transport> {
  let emit: (chunk: Uint8Array) => void = () => {};
  const timers: ReturnType<typeof setInterval>[] = [];
  let vivo = true;

  const enviar = (fr: Protobuf.Mesh.FromRadio) => {
    if (!vivo) return;
    emit(marco(toBinary(Protobuf.Mesh.FromRadioSchema, fr)));
  };

  const fromRadio = (v: Protobuf.Mesh.FromRadio["payloadVariant"]) =>
    create(Protobuf.Mesh.FromRadioSchema, { id: nextId(), payloadVariant: v });

  /** Wraps application data as if it came over the mesh */
  const meshPacket = (
    from: number,
    portnum: Protobuf.Portnums.PortNum,
    payload: Uint8Array,
    extra: { requestId?: number; to?: number; snr?: number } = {},
  ) =>
    fromRadio({
      case: "packet",
      value: create(Protobuf.Mesh.MeshPacketSchema, {
        from,
        to: extra.to ?? MI_NUM,
        id: nextId(),
        channel: 0,
        rxTime: Math.floor(Date.now() / 1000),
        rxSnr: extra.snr ?? 6.5,
        hopLimit: 3,
        payloadVariant: {
          case: "decoded",
          value: create(Protobuf.Mesh.DataSchema, {
            portnum,
            payload,
            requestId: extra.requestId ?? 0,
          }),
        },
      }),
    });

  const nodeInfo = (n: NodoSim) =>
    fromRadio({
      case: "nodeInfo",
      value: create(Protobuf.Mesh.NodeInfoSchema, {
        num: n.num,
        lastHeard: Math.floor(Date.now() / 1000),
        snr: 7 - n.hops * 2,
        hopsAway: n.hops,
        user: create(Protobuf.Mesh.UserSchema, {
          id: `!${n.num.toString(16)}`,
          longName: n.longName,
          shortName: n.shortName,
          hwModel: 43,
        }),
        position: create(Protobuf.Mesh.PositionSchema, {
          latitudeI: Math.round(n.lat * 1e7),
          longitudeI: Math.round(n.lon * 1e7),
          time: Math.floor(Date.now() / 1000),
        }),
        deviceMetrics: create(Protobuf.Telemetry.DeviceMetricsSchema, {
          batteryLevel: n.bateria,
          voltage: 3.7,
        }),
      }),
    });

  /** Startup sequence, the same the firmware sends on connect */
  const handshake = (configId: number) => {
    enviar(
      fromRadio({
        case: "myInfo",
        value: create(Protobuf.Mesh.MyNodeInfoSchema, {
          myNodeNum: MI_NUM,
          rebootCount: 1,
        }),
      }),
    );
    enviar(
      fromRadio({
        case: "config",
        value: create(Protobuf.Config.ConfigSchema, {
          payloadVariant: {
            case: "lora",
            value: {
              region: Protobuf.Config.Config_LoRaConfig_RegionCode.EU_868,
              modemPreset: Protobuf.Config.Config_LoRaConfig_ModemPreset.LONG_FAST,
              hopLimit: 3,
              txEnabled: true,
              usePreset: true,
            },
          },
        }),
      }),
    );
    enviar(
      fromRadio({
        case: "config",
        value: create(Protobuf.Config.ConfigSchema, {
          payloadVariant: { case: "device", value: {} },
        }),
      }),
    );
    enviar(
      fromRadio({
        case: "moduleConfig",
        value: create(Protobuf.ModuleConfig.ModuleConfigSchema, {
          payloadVariant: {
            case: "neighborInfo",
            value: { enabled: true, updateInterval: 14400, transmitOverLora: true },
          },
        }),
      }),
    );
    enviar(
      fromRadio({
        case: "channel",
        value: create(Protobuf.Channel.ChannelSchema, {
          index: 0,
          role: Protobuf.Channel.Channel_Role.PRIMARY,
          settings: { name: "SimuLong", psk: new Uint8Array([1]) },
        }),
      }),
    );
    // our own node also shows up in the NodeDB
    enviar(
      nodeInfo({
        num: MI_NUM,
        longName: "Nodo Simulado",
        shortName: "SIM",
        hops: 0,
        lat: 39.57,
        lon: 2.65,
        bateria: 101, // enchufado
      }),
    );
    for (const n of NODOS) enviar(nodeInfo(n));
    enviar(fromRadio({ case: "configCompleteId", value: configId }));
  };

  /** Routing ACK: without it messages would stay at "sent" */
  const ack = (requestId: number) =>
    enviar(
      meshPacket(
        MI_NUM,
        Protobuf.Portnums.PortNum.ROUTING_APP,
        toBinary(
          Protobuf.Mesh.RoutingSchema,
          create(Protobuf.Mesh.RoutingSchema, {
            variant: { case: "errorReason", value: Protobuf.Mesh.Routing_Error.NONE },
          }),
        ),
        { requestId },
      ),
    );

  // ── what the app sends to the radio ─────────────────────────────────────
  const recibirDeLaApp = (chunk: Uint8Array) => {
    // arrives already framed by toDeviceStream: 0x94 0xc3 and two length bytes
    const cuerpo =
      chunk[0] === 148 && chunk[1] === 195 ? chunk.subarray(4) : chunk;
    let msg: Protobuf.Mesh.ToRadio;
    try {
      msg = fromBinary(Protobuf.Mesh.ToRadioSchema, cuerpo);
    } catch {
      return; // stray chunk: the simulator doesn't reassemble
    }
    if (msg.payloadVariant.case === "wantConfigId") {
      setTimeout(() => handshake(msg.payloadVariant.value as number), 60);
      return;
    }
    if (msg.payloadVariant.case !== "packet") return;
    const p = msg.payloadVariant.value;
    if (p.payloadVariant.case !== "decoded") return;
    const data = p.payloadVariant.value;

    // ack everything that is sent, so the chat marks it delivered
    setTimeout(() => ack(p.id), 120);

    if (data.portnum === Protobuf.Portnums.PortNum.TRACEROUTE_APP) {
      // reply with an outbound and return route through a repeater
      const destino = p.to;
      const intermedio = NODOS.find((n) => n.num !== destino && n.hops === 0);
      const ruta = create(Protobuf.Mesh.RouteDiscoverySchema, {
        route: intermedio ? [intermedio.num] : [],
        snrTowards: [24, 12], // dB ×4, like the firmware
        routeBack: intermedio ? [intermedio.num] : [],
        snrBack: [20, 10],
      });
      setTimeout(
        () =>
          enviar(
            meshPacket(
              destino,
              Protobuf.Portnums.PortNum.TRACEROUTE_APP,
              toBinary(Protobuf.Mesh.RouteDiscoverySchema, ruta),
              { requestId: p.id },
            ),
          ),
        900,
      );
    }

    if (data.portnum === Protobuf.Portnums.PortNum.POSITION_APP) {
      // position request: the destination answers with its own
      const n = NODOS.find((x) => x.num === p.to);
      if (n) {
        setTimeout(
          () =>
            enviar(
              meshPacket(
                n.num,
                Protobuf.Portnums.PortNum.POSITION_APP,
                toBinary(
                  Protobuf.Mesh.PositionSchema,
                  create(Protobuf.Mesh.PositionSchema, {
                    latitudeI: Math.round(n.lat * 1e7),
                    longitudeI: Math.round(n.lon * 1e7),
                    time: Math.floor(Date.now() / 1000),
                  }),
                ),
              ),
            ),
          700,
        );
      }
    }

    if (data.portnum === Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP) {
      // someone answers on the channel so the chat has some life
      const quien = NODOS[1];
      setTimeout(
        () =>
          enviar(
            meshPacket(
              quien.num,
              Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP,
              enc.encode("recibido, cambio"),
              { to: 0xffffffff },
            ),
          ),
        1500,
      );
    }
  };

  // ── spontaneous mesh traffic ────────────────────────────────────────────
  const arrancarTrafico = () => {
    // telemetry every 20 s: feeds the charts and the battery forecast
    timers.push(
      setInterval(() => {
        for (const n of NODOS) {
          n.bateria = Math.max(1, n.bateria - (n.num === NODOS[3].num ? 0.8 : 0.1));
          enviar(
            meshPacket(
              n.num,
              Protobuf.Portnums.PortNum.TELEMETRY_APP,
              toBinary(
                Protobuf.Telemetry.TelemetrySchema,
                create(Protobuf.Telemetry.TelemetrySchema, {
                  time: Math.floor(Date.now() / 1000),
                  variant: {
                    case: "deviceMetrics",
                    value: {
                      batteryLevel: Math.round(n.bateria),
                      voltage: 3.3 + n.bateria / 200,
                      channelUtilization: 8 + Math.random() * 12,
                      airUtilTx: 2 + Math.random() * 5,
                    },
                  },
                }),
              ),
            ),
          );
        }
      }, 20_000),
    );

    // NeighborInfo every 45 s: fills the graph on the MESH tab
    timers.push(
      setInterval(() => {
        for (const n of NODOS) {
          const vecinos = NODOS.filter(
            (o) => o.num !== n.num && Math.abs(o.hops - n.hops) <= 1,
          ).map((o) =>
            create(Protobuf.Mesh.NeighborSchema, {
              nodeId: o.num,
              snr: 8 - Math.abs(o.hops - n.hops) * 4 - Math.random() * 3,
            }),
          );
          enviar(
            meshPacket(
              n.num,
              Protobuf.Portnums.PortNum.NEIGHBORINFO_APP,
              toBinary(
                Protobuf.Mesh.NeighborInfoSchema,
                create(Protobuf.Mesh.NeighborInfoSchema, {
                  nodeId: n.num,
                  nodeBroadcastIntervalSecs: 14400,
                  neighbors: vecinos,
                }),
              ),
            ),
          );
        }
      }, 45_000),
    );

    // a node that changes distance every 90 s: triggers the topology change
    // detection without waiting for a real repeater to go down
    timers.push(
      setInterval(() => {
        const n = NODOS[2];
        n.hops = n.hops === 2 ? 1 : 2;
        enviar(nodeInfo(n));
      }, 90_000),
    );

    // a stray message every 60 s
    timers.push(
      setInterval(() => {
        const n = NODOS[Math.floor(Math.random() * NODOS.length)];
        enviar(
          meshPacket(
            n.num,
            Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP,
            enc.encode(`prueba de cobertura desde ${n.shortName}`),
            { to: 0xffffffff },
          ),
        );
      }, 60_000),
    );
  };

  const transport = await makeTransport(
    async (chunk) => recibirDeLaApp(chunk),
    async (onData) => {
      emit = onData;
      arrancarTrafico();
      return () => {
        vivo = false;
        for (const t of timers) clearInterval(t);
      };
    },
    async () => {
      vivo = false;
      for (const t of timers) clearInterval(t);
    },
  );
  return transport;
}
