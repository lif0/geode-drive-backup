# GeodeDrive

[English](../README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · **Español**

[![CI](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-%3E%3D1.4.0-7c3aed.svg)](https://obsidian.md)
[![Mobile](https://img.shields.io/badge/mobile-iOS%20%7C%20Android-success.svg)](#)
[![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM-informational.svg)](#cifrado)

El plugin guarda una copia de seguridad de tu bóveda de Obsidian en **tu propio** Google Drive y,
además, puede cifrar los archivos y carpetas que elijas.

Funciona en escritorio y en el móvil: sin APIs de Node, sin `fetch`, sin dependencias en tiempo de
ejecución.

![panel](assets/panel.png)

> [!NOTE]
> **Esta traducción la generó un LLM y no la ha revisado un hablante nativo.** La fuente de verdad
> es el [README en inglés](../README.md): si los textos no coinciden, manda el inglés. Si
> encuentras una frase forzada, un error o un término mal elegido, edita `docs/README.es.md` y abre
> un PR, o [crea un issue](https://github.com/lif0/geode-drive-backup/issues). Aunque solo arregles
> una línea, ayuda. Los idiomas nuevos también son bienvenidos: copia el archivo en inglés a
> `docs/README.<código>.md`, mantén el mismo orden de secciones y añádelo a la fila de idiomas de
> arriba.

> Los nombres de comandos, ajustes y botones se dejan en inglés: así es como aparecen en la
> interfaz de Obsidian.

---

## Instalación

### Desde una release

1. Descarga `main.js` y `manifest.json` de la
   [última release](https://github.com/lif0/geode-drive-backup/releases).
2. Colócalos en `<tu bóveda>/.obsidian/plugins/geode-drive-backup/`.
3. Reinicia Obsidian y activa **GeodeDrive** en _Settings → Community plugins_.

### Desde el código fuente

```bash
git clone https://github.com/lif0/geode-drive-backup.git
cd geode-drive-backup
npm install
npm run build          # typecheck + lint + tests + bundle
```

Copia `main.js` y `manifest.json` a la carpeta del plugin dentro de la bóveda, o crea allí un
enlace simbólico al repositorio y ejecuta `npm run dev`: la compilación se actualizará sola.

---

## Configuración: tu propio cliente OAuth de Google

GeodeDrive nunca hace pasar tus notas por servidores ajenos, así que las credenciales de Google las
creas tú. Es una configuración de una sola vez, unos diez minutos.

1. Abre la [Google Cloud Console](https://console.cloud.google.com/) y crea un proyecto.
2. **APIs & Services → Library** → activa la **Google Drive API**.
3. **APIs & Services → OAuth consent screen**. En la consola actual esto abre **Google Auth
   Platform**. Pulsa **Get started** y rellena el nombre de la app, tu dirección como support
   email, **Audience: External** y tu dirección otra vez como información de contacto.
4. Abre la pestaña **Audience** y pulsa **Publish app** para que el estado pase a _In production_.
   Si piensas saltarte este paso, lee antes el aviso de abajo: para una herramienta de copias de
   seguridad es obligatorio.
5. Abre la pestaña **Clients** → **Create client** → tipo de aplicación
   **TVs and Limited Input devices** → ponle un nombre → **Create**.
6. Copia el **Client ID** y el **Client secret**.
7. En Obsidian: _Settings → Geode_ → pega ambos y pulsa **Connect**.
8. Un diálogo mostrará un código corto y una URL. Abre la URL en cualquier dispositivo donde puedas
   escribir cómodamente, introduce el código y autoriza el acceso: el diálogo se cierra solo.

> [!IMPORTANT]
> **No dejes la app en _Testing_.** A toda app External en ese estado Google le entrega un refresh
> token que caduca a los **7 días**. A partir de ahí GeodeDrive fallaría con «Google revoked this
> connection» una vez por semana, para siempre. El botón **Publish app** lo arregla de una vez por
> todas.
>
> Publicar no cuesta nada. Sigues siendo el único usuario, y `drive.file` es un permiso
> **non-sensitive**: no hace falta enviar nada a revisión ni pasar una auditoría de seguridad. Si
> la pantalla de consentimiento avisa de que la app no está verificada, es normal en una app que
> solo usas tú: abre **Advanced** y continúa.
>
> Si decides mantener el estado _Testing_ a propósito, añade antes tu propia cuenta en
> **Audience → Test users**. Esa sección solo existe mientras el estado es _Testing_: después de
> publicar ya no la encontrarás.

Por qué el tipo de cliente tiene ese nombre tan raro, por qué el cliente lo creas tú y por qué
publicar la app es seguro: [docs/auth-design.md](auth-design.md) (en inglés).

GeodeDrive solicita exactamente un permiso: `https://www.googleapis.com/auth/drive.file`. Solo da
acceso a los archivos que ha creado el propio plugin; no puede leer nada más de tu Drive.

Un token ya publicado deja de funcionar igualmente si revocas el acceso en
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) o si pasan seis meses
sin un solo push ni pull.

> **¿El inicio de sesión falla y Google rechaza el device flow?**
> Tu cliente es del tipo equivocado. O bien lo vuelves a crear como _TVs and Limited Input
> devices_, o bien cambias **Sign-in method** a _Redirect with PKCE_ en los ajustes. Ese flujo abre
> la página de consentimiento normal de Google, redirige a una URL `127.0.0.1` que, lógicamente,
> no carga, y te pide pegar el contenido de la barra de direcciones de vuelta en Obsidian. Es feo,
> pero no necesita un servidor web local, así que también funciona en el móvil.

En disco solo se escribe el refresh token. Los access token viven en memoria: el plugin los vuelve
a pedir cuando hacen falta.

---

## Uso

Hay siete comandos en la paleta (`Ctrl/Cmd+P`). Además hay un icono en la cinta y un elemento en la
barra de estado —ambos abren el panel— y, arriba en la pestaña de ajustes, los botones
**Push now** / **Pull now**.

| Comando                      | Qué hace                                                            |
| ---------------------------- | ------------------------------------------------------------------- |
| **Push changes to Drive**    | Sube los archivos nuevos y modificados. El resto lo omite.          |
| **Pull vault from Drive**    | Descarga la copia entera. Nunca sobrescribe, nunca borra.           |
| **Unlock encryption**        | Valida tu contraseña y guarda la clave en caché durante la sesión.  |
| **Connect Google account**   | Ejecuta el flujo de inicio de sesión.                               |
| **Show backup status**       | Conexión, carpeta, archivos rastreados y estado del cifrado.        |
| **Show progress panel**      | Abre el panel. El icono de la cinta y la barra de estado, lo mismo. |
| **Cancel current operation** | Para tras el archivo en curso. Nada queda escrito a medias.         |

### El panel

El icono de la cinta abre un panel en la barra lateral derecha, el mismo
[de la imagen del principio](#geodedrive). Desde ahí se lanza la copia de seguridad y ahí mismo se
ve cómo avanza. El panel por sí solo no envía nada hasta que pulsas un botón. Y antes de lanzarla
conviene mirar qué es exactamente lo que se va a enviar.

**Check** es un ensayo en seco: calcula qué enviaría un push sin enviar nada, y de paso le
pregunta a Drive cuánto espacio queda. No hace falta la contraseña para esto. El ensayo no es
gratis: para saber qué cambió hay que recorrer la bóveda igual que lo hace un push. Por eso se
lanza con un botón y no automáticamente cada vez que se abre el panel.

La última línea habla del espacio en Drive. Si no queda sitio, el push fallará con
`storageQuotaExceeded` y reintentar no sirve de nada. El panel te avisa de antemano, antes de
enviar.

### Puntos en el explorador de archivos

Junto a cada archivo y cada carpeta de la barra lateral de Obsidian aparece un punto que indica en
qué estado está el archivo.

| Punto       | Significado                                             |
| ----------- | ------------------------------------------------------- |
| **verde**   | está en Drive y no ha cambiado aquí desde entonces      |
| **naranja** | nunca se ha enviado, o cambió después del último envío  |
| **gris**    | excluido, y la fila aparece atenuada                    |

Una carpeta toma el color más «alarmante» de su contenido. Una carpeta verde significa que todos
los archivos que contiene ya están en Drive; una sola nota sin enviar tiñe de naranja toda la rama.

El color se calcula a partir del tamaño y la fecha de modificación del archivo, no del hash: es el
mismo atajo con el que un push decide que no hace falta releer un archivo. Si el hash de un archivo
está marcado como no fiable (se explica más abajo, en el punto sobre las marcas de tiempo), el
punto será naranja. Y es honesto: el siguiente push realmente volverá a leer ese archivo.

> Obsidian no ofrece a los plugins ninguna API para decorar el árbol de archivos, así que los
> puntos se dibujan directamente sobre el marcado del explorador, usando el atributo `data-path`
> que lleva cada fila. El plugin no lee nada privado, pero es una dependencia del marcado interno,
> no de un contrato oficial. Si los puntos desaparecen algún día, lo primero que hay que sospechar
> es justo eso. Se desactivan con el ajuste **Mark files in the file explorer**.

### Cómo seguir una ejecución

Mientras dura un push o un pull, se puede seguir en tres sitios. Ninguno se cierra por accidente.

- **La barra de estado**, abajo a la derecha: `Geode 142/486 · 38%`. Al hacer clic se abre el panel.
- **El panel.** Muestra dos barras: una para toda la ejecución y otra para el archivo en curso. Al
  lado se ven los bytes, el nombre del archivo y un botón Cancel. Ábrelo a mitad de un push y verás
  el push, no una pantalla vacía.
- **El aviso final** con el resumen.

La barra general cuenta bytes, no archivos, así que muestra un progreso honesto desde el primer
segundo: el plugin sabe de antemano qué archivos van a salir y cuánto pesan. Cien notas y un vídeo
no son ciento un pasos iguales.

La barra del archivo en curso solo se mueve con los archivos grandes, los que van por trozos. Son
los de más de 5 MB, que toman la ruta reanudable en fragmentos de 1 MB. Todo lo más pequeño va en
una sola petición, y el `requestUrl` de Obsidian no informa de nada hasta que la petición termina,
así que en los archivos pequeños la barra se llena de golpe. Eso es lo que ocurre en realidad, y
eso es lo que se muestra.

Gracias a los fragmentos, **Cancel actúa también dentro de un archivo grande**, no solo entre
archivos. Un vídeo de 400 MB se detiene al cabo de un megabyte, no al final.

> En el móvil Obsidian no ofrece barra de estado a los plugins. Ahí el progreso se sigue en el
> panel y con el icono de la cinta.

### Primera ejecución típica

```
Connect Google account   →   Push changes to Drive
```

El primer push crea la carpeta en Drive (por defecto se llama `Geode`) y lo sube todo. Después
solo sale lo que haya cambiado.

### Restaurar en un dispositivo nuevo

```
Instalar Geode  →  pegar el mismo client ID y secret  →  Connect  →  Pull vault from Drive
```

Pull descarga todos los archivos y reconstruye el árbol de carpetas a partir de los nombres
codificados. Si en la misma ruta de la bóveda ya hay un archivo y el plugin no puede demostrar que
ambos son idénticos, la copia de Drive se escribe al lado con el nombre `note (from drive).md`. Si
vuelve a haber colisión, será `(from drive 2)`, `(from drive 3)`, y así sucesivamente. **Pull nunca
borra ni sobrescribe nada.**

La coincidencia de rutas se comprueba sin distinguir mayúsculas de minúsculas, incluso en Linux.
Para Drive, `Note.md` y `note.md` son archivos distintos; para APFS, NTFS y el exFAT de una tarjeta
SD de Android son el mismo, así que escribir el segundo destruiría en silencio el primero. En un
sistema de archivos donde las mayúsculas sí cuentan, te llevas una copia `(from drive)` de más; el
error en el sentido contrario te costaría una nota perdida.

### Cómo detener una ejecución larga

El push y el pull se pueden interrumpir en cualquier momento: pulsa **Cancel** en el aviso de
progreso o ejecuta el comando **Cancel current operation**. El plugin termina el archivo en curso y
se detiene, así que en Drive no quedan archivos a medio subir ni en la bóveda archivos truncados.

Todo lo que ya se transfirió se queda donde está. El índice se guarda cada 25 archivos, no solo al
final, de modo que una ejecución interrumpida simplemente continúa donde se quedó, da igual si la
cancelaste tú o si al teléfono se le acabó la batería.

### Cómo leer el resumen

Cada ejecución termina con un aviso.

```
Push finished: 12 uploaded, 3 updated, 486 unchanged.

2 skipped — changed on another device:
  Journal/2026-07-30.md
  Projects/roadmap.md
```

Un **conflicto** significa que la copia de Drive cambió después de que este dispositivo la
escribiera. El plugin no adivina qué versión es la buena: omite el archivo y te lo dice. A partir
de ahí puedes hacer pull y quedarte con las dos copias, una junto a otra, o resolverlo a mano.

A veces el resumen trae además una **advertencia**: por ejemplo, que para una misma ruta hay dos
archivos en Drive, o que en la carpeta hay archivos que el plugin no puso ahí. Eso no entra en los
contadores, pero significa que la copia de seguridad no tiene exactamente la forma que crees.

---

## Qué entra exactamente en la copia de seguridad

En una bóveda rara vez hay solo notas. Suelen acabar ahí también resultados de compilación,
binarios, carpetas de programas enteras y vídeos pesados. A una copia de seguridad que se hace por
los textos, nada de eso le hace falta.

Hay dos interruptores. Ambos vienen desactivados por defecto y ambos entienden la sintaxis de
`.gitignore`.

| Ajuste                               | Qué hace                                                  |
| ------------------------------------ | --------------------------------------------------------- |
| **Respect the vault's `.gitignore`** | Lee el `.gitignore` de la raíz de la bóveda y lo aplica   |
| **Never upload these paths**         | Tus propias reglas, se aplican después del archivo        |

Las líneas de los ajustes se aplican en segundo lugar, así que un `!` en ellas puede devolver lo
que el `.gitignore` del repositorio excluyó. La bóveda es primero un repositorio y solo después una
copia de seguridad, y esos dos papeles no siempre necesitan los mismos archivos.

```gitignore
bin/                    # una carpeta a cualquier profundidad, también Projects/app/bin
[Oo]bj/                 # las clases de caracteres funcionan
/Drafts                 # la barra inicial lo ancla a la raíz de la bóveda
*.mp4                   # cualquier profundidad, cualquier carpeta
!Notes/demo.mp4         # …salvo este archivo
**/.idea/**/*.iml       # ** atraviesa carpetas
```

Se admiten comentarios `#`, negación `!` (gana la última regla que coincida), anclaje con `/`,
barra final para carpetas, `*`, `?`, `**` y las clases de caracteres `[abc]` / `[!a-z]`. Los
`.gitignore` anidados dentro de la bóveda no se leen: solo el de la raíz.

Tres cosas que conviene saber antes de activarlo.

- **Una regla sin barra coincide a cualquier profundidad.** `test/` excluye tanto `test/` en la
  raíz como `Notes/test/`. Así funciona git, y así es justo como se suele perder por accidente una
  carpeta de notas de verdad. Pulsa **Preview exclusions** en los ajustes: el plugin aplica las
  reglas a tu bóveda y muestra qué quedaría fuera. En el proceso no se sube nada.
- **Excluir no es borrar.** Si un archivo deja de entrar en la copia de seguridad, su copia en
  Drive no va a ninguna parte: el plugin no la actualizará ni la borrará, ni siquiera con la
  réplica de borrados activada. Una copia de seguridad que olvida un archivo el mismo día que lo
  excluyes no merece ese nombre.
- **Las exclusiones afectan al push, no al pull.** Deciden qué sale de este dispositivo. Todo lo
  que ya está en la copia se puede recuperar, que es para lo que existe la copia.

Un archivo excluido ni siquiera se abre. Los gigabytes excluidos dejan de costar tiempo en cada
push: ya no hay que leerlos y calcular su hash solo para saltarlos después. El resumen indica
cuántos archivos quedaron fuera.

El botón **Show what is excluded** del panel muestra la lista completa en forma de árbol. Las
carpetas empiezan plegadas y cada una lleva anotado cuántos archivos contiene y cuánto pesan.
Varios miles de rutas excluidas se convierten en una docena de filas que sí se pueden leer, y una
carpeta `Journal` que se coló en la lista junto a los artefactos de compilación resulta difícil de
pasar por alto. Arriba van las carpetas más pesadas: casi todo el beneficio de las exclusiones
suele concentrarse en dos o tres de ellas.

Los archivos y carpetas que empiezan por punto, Obsidian ni siquiera se los muestra a los plugins.
Por eso `.obsidian/`, `.git/`, `.idea/` y similares nunca han estado en la copia de seguridad, y
las reglas sobre ellos no cambian nada.

---

## Cifrado

Desactivado por defecto. Si se activa, los archivos cuya ruta coincide con alguno de tus prefijos
se cifran **antes** de salir del dispositivo.

- **Cifrado:** AES-256-GCM, con un nonce aleatorio de 12 bytes nuevo por archivo y por push.
- **Clave:** PBKDF2-SHA256, 600 000 iteraciones, clave de 32 bytes, sal aleatoria de 16 bytes por
  bóveda.
- **Contenedor:** `MAGIC "OBEV" | VERSION 0x01 | SALT (16) | NONCE (12) | ciphertext+tag`.

La clave se deriva una vez al desbloquear y se mantiene en memoria: derivarla de nuevo para cada
archivo colgaría Obsidian en cualquier bóveda real. Al descargarse el plugin, la clave se borra. La
contraseña en sí no se escribe en ningún sitio.

### Elegir qué se cifra

En los ajustes enumeras prefijos de ruta, uno por línea. Las reglas son simples a propósito: las
reglas demasiado listas acaban tarde o temprano con un archivo que creías cifrado subiéndose en
claro.

| Prefijo    | Coincide con                                | No coincide con |
| ---------- | ------------------------------------------- | --------------- |
| `Journal`  | `Journal`, `Journal/2026.md`, `Journal/a/b` | `Journalism.md` |
| `Journal/` | lo mismo que arriba                         | `Journalism.md` |
| `Journal*` | `Journal/2026.md`, `Journalism.md`          | `Diary.md`      |

Distingue mayúsculas y minúsculas. `*` solo funciona al final de la línea. Las líneas que empiezan
por `#` se ignoran.

### El archivo de comprobación de contraseña

El primer push cifrado escribe en la carpeta de Drive un archivo pequeño llamado `__keycheck`: en
él van la sal de la bóveda y una cadena marcadora que el plugin conoce. Un dispositivo nuevo lo
descarga primero y valida tu contraseña **antes de tocar ningún dato real**. Si la contraseña es
incorrecta, todo se detiene de inmediato y nada cambia en disco.

### Limitaciones que conviene conocer

- **Los nombres de archivo no se cifran.** Las rutas se codifican en base64url para que Drive las
  acepte, y eso es codificación, no cifrado. Cualquiera con acceso a la carpeta verá todas las
  rutas de tu bóveda.
- **El tamaño de los archivos no se oculta.** Un contenedor pesa lo mismo que el archivo original
  más 49 bytes.
- **No hay recuperación.** Si olvidas la contraseña, los archivos cifrados se pierden: para ti y
  para todos los demás.
- Que un archivo esté cifrado o no lo decide el plugin al descargarlo por la cabecera `OBEV`. Ni la
  extensión ni el indicador `enc` de los metadatos de Drive sirven para eso: los dos se
  desincronizan de la realidad con el tiempo; la cabecera, no.

---

## Recuperación de desastres sin Obsidian

`tools/decrypt.mjs` es totalmente autónomo: no toma nada de `src/` y no necesita ni `npm install`
ni compilación. Pon ese único archivo junto a la carpeta de Drive descargada y podrás recuperar las
notas solo con Node y la contraseña.

```bash
# Un archivo a stdout
node tools/decrypt.mjs 5rWL6K-VLm1k

# Un archivo a disco
node tools/decrypt.mjs 5rWL6K-VLm1k -o note.md

# Reconstruir la bóveda entera desde una carpeta de Drive descargada:
# decodifica los nombres, descifra lo que esté cifrado y copia el resto tal cual
GEODE_PASSPHRASE='…' node tools/decrypt.mjs --dir ./downloaded-Geode --out ./restored

# Comprobar que esta herramienta coincide con el plugin
node tools/decrypt.mjs --verify-vectors test/vectors.json
```

El script toma la contraseña de `--passphrase`. Si no está, de la variable `GEODE_PASSPHRASE`. Y si
tampoco, simplemente la pregunta.

### Vectores de referencia

`test/vectors.json` fija cuatro casos: archivo vacío, ASCII corto, UTF-8 con cirílico y emoji, y
1 MiB de datos binarios. Cada uno registra la contraseña, la sal, el nonce, el texto en claro y el
contenedor exacto que se espera.

Dos implementaciones independientes deben coincidir en los cuatro: a `src/core/container.ts` lo
verifica `npm test`, y a `tools/decrypt.mjs`, `npm run verify:vectors`. CI ejecuta ambas. Los
vectores solo se añaden: si el formato cambia, hay que subir `VERSION` y agregar casos nuevos, no
editar los antiguos.

---

## Cómo se detectan los cambios

Para saber si un archivo cambió, el plugin compara el SHA-256 de su **texto en claro** con un
índice local en `data.json`.

Esto importa más de lo que parece. Los archivos cifrados reciben un nonce nuevo en cada push, así
que su texto cifrado —y con él el `md5Checksum` de Drive— cambia cada vez, aunque la nota no haya
cambiado. Si el plugin se guiara por las sumas de verificación de Drive, tendría que volver a subir
la bóveda entera en cada ejecución. El hash del texto en claro es lo único que permanece igual.

El md5 remoto sirve para una sola cosa: por él se ve que **otro dispositivo** reescribió el
archivo. Eso es un conflicto, y el plugin se niega a machacar ese archivo.

El hash del texto en claro nunca sale de tu dispositivo. Si el plugin lo subiera junto con un
archivo cifrado, cualquiera con acceso a la carpeta podría confirmar una conjetura sobre su
contenido.

Qué se deriva de esto.

- Si a un archivo le coinciden **tanto** la fecha de modificación **como** el tamaño, el plugin
  toma el hash registrado y ni siquiera abre el archivo. En una bóveda grande donde cambió poco, el
  push recorre todos los archivos pero apenas lee ninguno. La decisión la sigue tomando solo el
  sha256: la fecha de modificación no demuestra que el archivo cambió, solo dice que pudo cambiar.
- Este truco solo funciona si el reloj del sistema de archivos es más fino que tus ediciones.
  FAT32 —el formato habitual de una tarjeta SD de Android— redondea la hora a dos segundos. Una
  edición que caiga en el mismo tic sin cambiar el tamaño del archivo pasaría desapercibida para
  siempre. Por eso, si un archivo se modificó hace menos de un tic, su hash se marca como no fiable
  y la próxima vez el archivo se vuelve a leer.
- Pull no usa esos atajos y calcula el hash de todo. Se recurre a él cuando algo ya salió mal, y
  ahí el error cuesta más caro: si el plugin diera por hecho que el archivo local coincide con la
  copia de seguridad, no descargaría el duplicado al lado.
- Las rutas se normalizan a Unicode NFC. macOS devuelve `é` como `e` más un acento aparte, mientras
  que Windows y Linux usan un solo carácter. Sin normalización, la misma nota subiría a Drive dos
  veces con nombres distintos y entraría en conflicto consigo misma eternamente.
- Perder `data.json` no es grave. El siguiente push verá archivos de los que no sabe nada, los
  encontrará en Drive y avisará de conflictos en vez de machacarlos. Pull reconstruye el índice.
- La entrada de una ruta que ya no existe ni en la bóveda **ni** en Drive se elimina del índice.
  Así `data.json` no crece sin límite y el contador de archivos rastreados sigue siendo honesto.
- `.obsidian/` no entra nunca en la copia de seguridad: ahí vive `data.json`, y dentro está tu
  refresh token de Google.

### Hablando con Drive

- **La limitación de velocidad es lo normal, no un error.** A una ráfaga de subidas Drive responde
  de forma rutinaria con 429 o un 5xx pasajero. El plugin reintenta esas peticiones con esperas
  crecientes y algo de azar, respeta `Retry-After` y hace hasta cinco intentos. Un 403 por límite
  de frecuencia también se reintenta; un 403 con `storageQuotaExceeded` —el del espacio agotado—
  no: esperar ahí no sirve. La cancelación se comprueba también durante la espera, así que no habrá
  que aguantar una pausa de veinte segundos hasta el final.
- **Si todo falla con el mismo error, la ejecución se detiene.** Tras cinco fallos seguidos de red
  o de credenciales, el plugin termina y lo comunica. De lo contrario recorrería dos mil archivos y
  notificaría dos mil veces el mismo problema. Todo lo que llegó a subirse queda registrado.
- **Los archivos de más de 5 MB van por una sesión reanudable, de 1 MB en 1 MB.** Google recomienda
  multipart solo para archivos de hasta 5 MB, y los adjuntos grandes son justo los archivos que una
  copia de seguridad no puede permitirse perder. Subir por fragmentos cuesta una petición extra por
  megabyte, pero a cambio da progreso dentro del archivo y un Cancel que no solo funciona entre
  archivos. Las descargas grandes van igual, por rangos.
- **El id de carpeta guardado se comprueba, no se da por bueno.** Si la carpeta de Drive acabó en
  la papelera o conectaste otra cuenta de Google, la petición de listado seguirá funcionando y
  devolverá una lista vacía; desde fuera parece que Drive perdió la bóveda entera. Una petición al
  principio de cada ejecución convierte esa situación en una simple búsqueda de la carpeta por
  nombre.
- **Una misma ruta puede estar ocupada por dos archivos en Drive.** Drive no exige nombres únicos,
  así que dos dispositivos que crean la misma nota casi a la vez producen exactamente eso. El
  plugin se queda con el archivo más reciente —y elige igual en todos los dispositivos— y lo cuenta
  en el resumen en vez de esconder la otra copia.

### Cómo se almacena todo en Drive

Plano. Una carpeta, un archivo de Drive por cada archivo de la bóveda, sin anidamiento.

```
Geode/
  bm90ZS5tZA                    ← base64url("note.md")
  Sm91cm5hbC8yMDI2LTA4LTAxLm1k  ← base64url("Journal/2026-08-01.md")
  __keycheck
```

La ruta va directamente en el nombre del archivo porque las `appProperties` de Drive están
limitadas a unos 124 bytes por par clave/valor: cualquier ruta con caracteres no ASCII sencillamente
no cabe. En `appProperties` solo se guarda `{ v, enc }`.

Cada subida declara esa carpeta como padre, así que lo que escribe el plugin no puede acabar en
otro sitio. Y `drive.file` le impide ver el resto de tu Drive.

La carpeta se crea en la raíz de «Mi unidad», y el plugin no ofrecerá otro sitio: con `drive.file`
no ve tu árbol de carpetas, así que no tiene de dónde sacar un id de padre. Si quieres ponerla en
orden, **arrástrala una vez en la interfaz web de Drive**. El plugin la localiza por su file id y
ni notará la mudanza. Y si algún día se pierde `data.json`, la búsqueda de respaldo va por nombre,
sin restricción de padre, y encontrará la carpeta donde la hayas dejado.

---

## Referencia de ajustes

| Ajuste                          | Por defecto     | Notas                                                             |
| ------------------------------- | --------------- | ----------------------------------------------------------------- |
| Client ID / secret              | vacío           | Tu propio cliente OAuth de Google                                  |
| Sign-in method                  | Device          | Cambia a PKCE solo si Google rechaza el device flow                |
| Drive folder name               | `Geode`         | Si lo cambias tras un push, el plugin mirará en otra carpeta       |
| Respect the vault's .gitignore  | desactivado     | Lee el `.gitignore` raíz y omite lo que excluye                    |
| Never upload these paths        | vacío           | Tus reglas, sintaxis `.gitignore`, se aplican después de él        |
| Mark files in the file explorer | activado        | Un punto por archivo y carpeta: verde, naranja o gris              |
| Encrypt selected paths          | desactivado     | Activa la lista de prefijos de abajo                               |
| Encrypted paths                 | vacío           | Un prefijo por línea                                               |
| Ask for the passphrase          | Una por sesión  | O en cada push y cada pull                                         |
| **Mirror deletions to Drive**   | **desactivado** | Activado, un borrado local elimina para siempre la copia de Drive  |

> **Sobre la réplica de borrados.** Mientras el ajuste está desactivado, un archivo borrado en
> local sigue en la copia de seguridad; normalmente esa es justo la razón de tener una. Cuando está
> activado, el push elimina la copia de Drive para siempre, sin pasar por la papelera. Una copia de
> seguridad que olvida todo lo que borraste ya no podrá devolvértelo.
>
> Esto no afecta a las exclusiones. Incluso con la réplica de borrados activada, añadir una ruta a
> `.gitignore` no borra su copia de Drive. Un archivo excluido es un archivo que el plugin dejó de
> tocar, no uno que pediste eliminar.

---

## Desarrollo

```bash
npm run dev             # esbuild en modo vigilancia
npm run typecheck       # tsc sobre src, test y tools
npm run lint            # eslint con reglas basadas en tipos
npm run test            # vitest sobre src/core
npm run verify:vectors  # el descifrador autónomo contra los vectores de referencia
npm run format
npm run build           # todo a la vez y luego el bundle de producción
```

### Estructura

```
src/
  main.ts        ciclo de vida, comandos y cableado: sin lógica de negocio
  types.ts       tipos con marca, Result, AppError
  settings.ts    forma de los ajustes, valores por defecto, migración
  core/          lógica pura: container, kdf, path-codec, selector, ignore,
                 diff, backup-state, path-tree, bytes
  drive/         auth-provider, device-flow, pkce-flow, client, dto
  ops/           push, pull, estimate, folder, index-store
  ui/            settings-tab, modales, progress hub, panel de progreso
test/            vitest solo sobre src/core: sin mocks ni stub de Obsidian
tools/           descifrador autónomo, generador de vectores, bump de versión
```

Dos reglas que la compilación comprueba por sí misma, no de palabra.

- **Nada dentro de `src/core/` importa `obsidian`.** Toda la E/S llega desde fuera, así que la
  criptografía y la lógica de comparación se pueden probar en Node puro, sin mocks.
- **Nada dentro de `src/` toca APIs de Node.** `tsconfig.json` define `types: []`, así que
  `Buffer`, `process` y `require` directamente no compilan, y ESLint además los prohíbe por nombre
  junto con `fetch`. Todo el HTTP pasa por `requestUrl` de Obsidian: es lo único que esquiva CORS
  en el renderer.

Comprobarlo es fácil: pon `Buffer.from('x')` en cualquier archivo bajo `src/` y tanto
`npm run typecheck` como `npm run lint` lo rechazarán.

---

## Licencia

[Apache-2.0](../LICENSE)
