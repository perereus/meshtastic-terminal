# Meshtastic Terminal

Cliente de escritorio para redes [Meshtastic](https://meshtastic.org), con
estética de terminal fosforescente. Windows, construido con Tauri 2, React 19 y
TypeScript.

Se conecta a un nodo por **serie (USB)**, **BLE** o **TCP**, y guarda en SQLite
local todo lo que oye: mensajes, telemetría, traceroutes y vecinos. La malla
sigue emitiendo cuando la app está cerrada, pero solo se registra lo que llega
mientras está conectada.

## Pantallas

- **CHAT** — canales y mensajes directos, estado de envío (en cola / enviado /
  entregado / fallo) con reintento, y búsqueda sobre todo el historial.
- **NODOS** — lista ordenable y filtrable, detalle por nodo con traceroute e
  historial, petición de posición, favoritos, ignorados, reboot y apagado
  remotos por canal admin.
- **MAPA** — nodos y waypoints sobre OpenStreetMap. El firmware reduce la
  precisión de las posiciones, así que los nodos que comparten coordenada se
  agrupan en un marcador.
- **MALLA** — grafo de la red. Línea continua = vecino directo (módulo
  NeighborInfo); discontinua = tramo deducido de un traceroute. El grosor sale
  del SNR.
- **CONFIG** — usuario, LoRa, dispositivo, canales (con PSK, rol, MQTT y
  precisión de posición), módulos, posición fija, backup a JSON y purga de la
  base.
- **TELEMETRÍA** — gráficas de batería, tensión, canal ocupado, temperatura y
  demás, con rangos de 6 h a 30 días.

La app está en español e inglés (CONFIG // APLICACIÓN), con cinco temas de
color. Los textos de estética terminal se quedan en inglés a propósito.

## Desarrollo

```bash
npm install
npm run tauri dev     # app con recarga en caliente
npm test              # self-checks (URLs de canal, grafo de malla)
npm run build         # solo el frontend + comprobación de tipos
```

Hace falta el [entorno de Rust para Tauri](https://tauri.app/start/prerequisites/).

## Compilar el instalador

```bash
npm run tauri build
```

Deja dos paquetes en `src-tauri/target/release/bundle/`:

- `nsis/Meshtastic Terminal_<versión>_x64-setup.exe` — instalador normal
- `msi/Meshtastic Terminal_<versión>_x64_en-US.msi` — para despliegue

## Dónde vive la base de datos

En la carpeta de datos de la app (`%APPDATA%/com.pere.meshtastic-client`). El
identificador de la app decide esa ruta: cambiarlo deja el historial anterior
huérfano.

## Licencia

La fuente JetBrains Mono está empaquetada bajo la OFL; ver
`src/assets/fonts/OFL.txt`.
