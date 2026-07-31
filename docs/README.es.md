# Geode

[English](../README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · **Español**

[![CI](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-%3E%3D1.4.0-7c3aed.svg)](https://obsidian.md)
[![Mobile](https://img.shields.io/badge/mobile-iOS%20%7C%20Android-success.svg)](#)
[![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM-informational.svg)](#cifrado)

Copia de seguridad, no sincronización. Envía tu bóveda de Obsidian a **tu propio** Google Drive,
recupérala en un dispositivo nuevo y, si quieres, cifra las carpetas que elijas antes de que salgan
de tu equipo.

Funciona en escritorio y en el móvil: sin APIs de Node, sin `fetch`, sin dependencias en tiempo de
ejecución.

> [!NOTE]
> **Esta traducción la generó un LLM y no la ha revisado un hablante nativo.** La fuente de verdad
> es el [README en inglés](../README.md); si algo no coincide, manda el inglés. Si encuentras una
> frase forzada, un error o un término mal elegido, las correcciones son muy bienvenidas: edita
> `docs/README.es.md` y abre un PR, o [crea un issue](https://github.com/lif0/geode-drive-backup/issues).
> Aunque solo arregles una línea, ayuda.

> Los nombres de comandos, ajustes y botones se dejan en inglés porque así aparecen en la interfaz
> de Obsidian.

---

## Qué hace y qué no hace deliberadamente

| Hace                                                 | No hace                                          |
| ---------------------------------------------------- | ------------------------------------------------ |
| Sube los archivos que cambiaron desde el último push | Fusión a tres bandas                             |
| Reconstruye la bóveda entera en un equipo nuevo      | Sincronización en tiempo real o en segundo plano |
| Cifra rutas seleccionadas en el cliente              | Borrar algo en local, nunca                      |
| Se niega a sobrescribir cambios de otro dispositivo  | Propagar borrados (salvo que lo actives)         |
| Informa de los conflictos y sigue adelante           | Guardar historial ni versiones de archivos       |

Si lo que necesitas es un motor de sincronización, esta no es la herramienta. Geode es lo que
ejecutas antes de un cambio arriesgado en tu bóveda, y lo que ejecutas en un portátil nuevo.

---

## Instalación

### Desde una release

1. Descarga `main.js` y `manifest.json` de la
   [última release](https://github.com/lif0/geode-drive-backup/releases).
2. Colócalos en `<tu bóveda>/.obsidian/plugins/geode-drive-backup/`.
3. Reinicia Obsidian y activa **Geode** en _Settings → Community plugins_.

### Desde el código fuente

```bash
git clone https://github.com/lif0/geode-drive-backup.git
cd geode-drive-backup
npm install
npm run build          # typecheck + lint + tests + bundle
```

Copia `main.js` y `manifest.json` a la carpeta de plugins de tu bóveda, o crea allí un enlace
simbólico al repositorio y ejecuta `npm run dev` para compilar en modo vigilancia.

---

## Configuración: tu propio cliente OAuth de Google

Geode nunca hace pasar tus notas por un tercero, así que las credenciales de Google las pones tú. Es
un trabajo de una sola vez, unos diez minutos.

1. Abre la [Google Cloud Console](https://console.cloud.google.com/) y crea un proyecto.
2. **APIs & Services → Library** → activa la **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → elige _External_, rellena los campos obligatorios y
   añade tu propia cuenta de Google en **Test users**. No hace falta publicar la app ni enviarla a
   revisión.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   Elige el tipo de aplicación **TVs and Limited Input devices**.
5. Copia el **Client ID** y el **Client secret**.
6. En Obsidian: _Settings → Geode_ → pega ambos y pulsa **Connect**.
7. Un diálogo mostrará un código corto y una URL. Abre la URL en cualquier dispositivo donde puedas
   escribir cómodamente, introduce el código y autoriza el acceso. El diálogo se cierra solo.

Geode solicita exactamente un permiso: `https://www.googleapis.com/auth/drive.file`. Solo da acceso
a los archivos que ha creado este plugin; no puede leer nada más de tu Drive. El permiso amplio
`drive` no se solicita nunca: es un permiso restringido que exige una auditoría de seguridad de
pago, y una herramienta de copias de seguridad no tiene nada que hacer ahí.

> **¿El inicio de sesión falla y Google rechaza el device flow?**
> Tu cliente es del tipo equivocado. O bien lo vuelves a crear como _TVs and Limited Input
> devices_, o bien cambias **Sign-in method** a _Redirect with PKCE_ en los ajustes. Ese flujo abre
> la página de consentimiento normal de Google, redirige a una URL `127.0.0.1` que no carga y te
> pide pegar el contenido de la barra de direcciones de vuelta en Obsidian. Es feo, pero no
> necesita un servidor web local, así que también funciona en el móvil.

En disco solo se escribe el refresh token. Los access token viven en memoria y se vuelven a obtener
cuando hacen falta.

---

## Uso

Cinco comandos, todos desde la paleta de comandos (`Ctrl/Cmd+P`):

| Comando                    | Qué hace                                                           |
| -------------------------- | ------------------------------------------------------------------ |
| **Push changes to Drive**  | Sube los archivos nuevos y modificados. El resto lo omite.         |
| **Pull vault from Drive**  | Descarga la copia entera. Nunca sobrescribe, nunca borra.          |
| **Unlock encryption**      | Valida tu contraseña y guarda la clave en caché durante la sesión. |
| **Connect Google account** | Ejecuta el flujo de inicio de sesión.                              |
| **Show backup status**     | Conexión, carpeta, archivos rastreados y estado del cifrado.       |

### Primera ejecución típica

```
Connect Google account   →   Push changes to Drive
```

El primer push crea la carpeta en Drive (nombre por defecto: `Geode`) y lo sube todo. Los siguientes
solo suben lo que haya cambiado.

### Restaurar en un dispositivo nuevo

```
Instalar Geode  →  pegar el mismo client ID y secret  →  Connect  →  Pull vault from Drive
```

Pull descarga todos los archivos y reconstruye el árbol de carpetas a partir de los nombres
codificados. Si la bóveda ya tiene un archivo en la ruta entrante y Geode no puede demostrar que son
idénticos, la copia entrante se escribe como `note (from drive).md`; si vuelve a haber colisión, se
convierte en `(from drive 2)`, `(from drive 3)`, y así sucesivamente. **Pull nunca borra ni
sobrescribe.**

### Cómo leer el resumen

Cada ejecución termina con un aviso de resumen:

```
Push finished: 12 uploaded, 3 updated, 486 unchanged.

2 skipped — changed on another device:
  Journal/2026-07-30.md
  Projects/roadmap.md
```

Un **conflicto** significa que la copia de Drive cambió desde la última vez que este dispositivo la
escribió. Geode no va a adivinar qué lado gana, así que omite el archivo y te lo dice. Se resuelve
haciendo pull —te quedas con las dos copias, una al lado de la otra— o decidiendo a mano.

---

## Cifrado

Desactivado por defecto. Cuando está activo, los archivos cuya ruta coincide con alguno de tus
prefijos se cifran **antes** de salir del dispositivo.

- **Cifrado:** AES-256-GCM, con un nonce aleatorio de 12 bytes nuevo por archivo y por push.
- **Clave:** PBKDF2-SHA256, 600 000 iteraciones, clave de 32 bytes, sal aleatoria de 16 bytes por
  bóveda.
- **Contenedor:** `MAGIC "OBEV" | VERSION 0x01 | SALT (16) | NONCE (12) | ciphertext+tag`.

La clave se deriva una sola vez por desbloqueo y se guarda en memoria: derivarla por archivo
congelaría Obsidian en cualquier bóveda real. Se borra cuando el plugin se descarga. La contraseña
en sí no se escribe en ningún sitio.

### Elegir qué se cifra

Un prefijo de ruta por línea en los ajustes. La regla es deliberadamente tonta, porque una regla
lista significa que un archivo que creías cifrado se subió en claro:

| Prefijo    | Coincide con                                | No coincide con |
| ---------- | ------------------------------------------- | --------------- |
| `Journal`  | `Journal`, `Journal/2026.md`, `Journal/a/b` | `Journalism.md` |
| `Journal/` | lo mismo que arriba                         | `Journalism.md` |
| `Journal*` | `Journal/2026.md`, `Journalism.md`          | `Diary.md`      |

Distingue mayúsculas y minúsculas, `*` solo es especial al final, y las líneas que empiezan por `#`
se ignoran.

### El archivo de comprobación de contraseña

El primer push cifrado escribe en la carpeta de Drive un archivo pequeño llamado `__keycheck`.
Contiene la sal de la bóveda y una cadena marcadora conocida. Un dispositivo nuevo lo descarga
primero y valida tu contraseña contra él **antes de tocar ningún dato real**: una contraseña
incorrecta aborta de inmediato, sin haber cambiado nada en disco.

### Limitaciones que conviene conocer

- **Los nombres de archivo no se cifran.** Las rutas se codifican en base64url para que Drive las
  acepte, y eso es codificación, no cifrado. Cualquiera con acceso a la carpeta puede listar todas
  las rutas de tu bóveda.
- **El tamaño de los archivos no se oculta.** Un contenedor ocupa la longitud del texto en claro más
  49 bytes.
- **No hay recuperación.** Si olvidas la contraseña, los archivos cifrados se pierden: para ti y
  para todos los demás.
- Que un archivo esté cifrado o no lo decide la cabecera `OBEV` al descargarlo, no la extensión ni
  el indicador `enc` de los metadatos de Drive. Esos dos se desincronizan con el tiempo; la cabecera
  no.

---

## Recuperación de desastres sin Obsidian

`tools/decrypt.mjs` es autónomo. No importa nada de `src/`, no necesita `npm install` ni compilación.
Copia ese único archivo junto a una carpeta de Drive descargada y podrás recuperar tus notas solo con
Node y tu contraseña.

```bash
# Un archivo a stdout
node tools/decrypt.mjs 5rWL6K-VLm1k

# Un archivo a disco
node tools/decrypt.mjs 5rWL6K-VLm1k -o note.md

# Reconstruir una bóveda entera desde una carpeta de Drive descargada:
# decodifica los nombres, descifra lo que esté cifrado y copia el resto tal cual
GEODE_PASSPHRASE='…' node tools/decrypt.mjs --dir ./downloaded-Geode --out ./restored

# Demostrar que esta herramienta coincide con el plugin
node tools/decrypt.mjs --verify-vectors test/vectors.json
```

La contraseña se toma de `--passphrase`; si no, de `GEODE_PASSPHRASE`; y si no, se pide de forma
interactiva.

### Vectores de referencia

`test/vectors.json` contiene cuatro casos congelados: archivo vacío, ASCII corto, UTF-8 con
cirílico y emoji, y 1 MiB de datos binarios. Cada uno registra la contraseña, la sal, el nonce, el
texto en claro y el contenedor exacto que se espera.

Dos implementaciones independientes deben coincidir en todos ellos: `src/core/container.ts`
(verificada por `npm test`) y `tools/decrypt.mjs` (verificada por `npm run verify:vectors`). CI
ejecuta las dos. Los vectores solo se añaden: cambiar el formato significa subir `VERSION` y agregar
casos, nunca editar los existentes.

---

## Cómo se detectan los cambios

Geode decide que un archivo está obsoleto comparando el SHA-256 de su **texto en claro** con un
índice local guardado en `data.json`.

Esto importa más de lo que parece. Los archivos cifrados reciben un nonce nuevo en cada push, así que
su texto cifrado —y por tanto el `md5Checksum` de Drive— cambia siempre, aunque la nota no lo haya
hecho. Cualquier comprobación de obsolescencia basada en sumas de verificación remotas volvería a
subir la bóveda entera en cada ejecución. El hash del texto en claro es la única señal que se queda
quieta.

El md5 remoto se usa para una sola cosa: detectar que **otro dispositivo** reescribió un archivo
desde el último push de este. Eso es un conflicto, y Geode se niega a sobrescribirlo.

El hash del texto en claro nunca sale de tu dispositivo. Subirlo para un archivo cifrado permitiría
a cualquiera confirmar una conjetura sobre su contenido.

Consecuencias que conviene conocer:

- El push lee todos los archivos de la bóveda para calcular su hash. Es correcto, pero no sale
  gratis en una bóveda llena de adjuntos grandes.
- Perder `data.json` no es fatal. El siguiente push verá archivos de los que no tiene constancia, los
  encontrará ya en Drive y los reportará como conflictos en lugar de machacarlos. El pull reconstruye
  el índice.
- `.obsidian/` nunca se respalda. Ahí es donde vive `data.json`, y con él tu refresh token de Google.

### Cómo se almacena en Drive

Plano. Una carpeta, un archivo de Drive por cada archivo de la bóveda, sin replicar la jerarquía:

```
Geode/
  bm90ZS5tZA                    ← base64url("note.md")
  Sm91cm5hbC8yMDI2LTA4LTAxLm1k  ← base64url("Journal/2026-08-01.md")
  __keycheck
```

La ruta vive en el nombre del archivo porque las `appProperties` de Drive están limitadas a unos 124
bytes por par clave/valor, y cualquier ruta no ASCII se pasa de ahí. Las `appProperties` solo llevan
`{ v, enc }`.

---

## Referencia de ajustes

| Ajuste                        | Por defecto     | Notas                                                    |
| ----------------------------- | --------------- | -------------------------------------------------------- |
| Client ID / secret            | vacío           | Tu propio cliente OAuth de Google                        |
| Sign-in method                | Device          | Cambia a PKCE solo si Google rechaza el device flow      |
| Drive folder name             | `Geode`         | Cambiarlo tras un push apunta a otra carpeta             |
| Encrypt selected paths        | desactivado     | Activa la lista de prefijos de abajo                     |
| Encrypted paths               | vacío           | Un prefijo por línea                                     |
| Ask for the passphrase        | Una por sesión  | O en cada push y cada pull                               |
| **Mirror deletions to Drive** | **desactivado** | Activado, un borrado local elimina para siempre la copia |

> **Sobre replicar los borrados:** con la opción desactivada, un archivo que borres en local sigue en
> la copia de seguridad, que suele ser exactamente el motivo de tener una. Con ella activada, el push
> borra la copia de Drive de forma permanente, saltándose la papelera de Drive. Una copia de
> seguridad que olvida lo que borraste no puede devolvértelo.

---

## Desarrollo

```bash
npm run dev             # esbuild en modo vigilancia
npm run typecheck       # tsc sobre src, test y tools
npm run lint            # eslint con reglas basadas en tipos
npm run test            # vitest sobre src/core
npm run verify:vectors  # el descifrador autónomo contra los vectores de referencia
npm run format
npm run build           # todo lo anterior y luego el bundle de producción
```

### Estructura

```
src/
  main.ts        ciclo de vida, comandos y cableado: sin lógica de negocio
  types.ts       tipos con marca, Result, AppError
  settings.ts    forma de los ajustes, valores por defecto, migración
  core/          lógica pura: container, kdf, path-codec, selector, diff, bytes
  drive/         auth-provider, device-flow, pkce-flow, client, dto
  ops/           push, pull, index-store
  ui/            settings-tab, modales, progress
test/            vitest solo sobre src/core: sin mocks ni stub de Obsidian
tools/           descifrador autónomo, generador de vectores, bump de versión
```

Dos reglas que la compilación impone de forma mecánica, no por convención:

- **Nada dentro de `src/core/` puede importar `obsidian`.** Toda la E/S se inyecta desde fuera, y eso
  es justo lo que permite probar la criptografía y la lógica de diff en Node puro, sin mocks.
- **Nada dentro de `src/` puede tocar APIs de Node.** `tsconfig.json` define `types: []`, así que
  `Buffer`, `process` y `require` no compilan, y ESLint los prohíbe por nombre junto con `fetch`.
  Todo el HTTP pasa por `requestUrl` de Obsidian, lo único que esquiva CORS en el renderer.

Pruébalo: pon `Buffer.from('x')` en cualquier archivo bajo `src/` y tanto `npm run typecheck` como
`npm run lint` lo rechazarán.

---

## Licencia

[Apache-2.0](../LICENSE)
