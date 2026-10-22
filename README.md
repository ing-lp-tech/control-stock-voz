# StockVoz 6 · Control de stock inteligente

App web (PWA instalable) para controlar stock **por voz**, con **pistola lectora** o **cámara**, imprimir **etiquetas con código de barras o QR** y guardar todo en **Supabase** con cuentas que vos aprobás.

Creada por **Ingeniero Emprendedor** · WhatsApp +54 9 11 6202-1005

---

## Qué hace

| Función | Detalle |
|---|---|
| Dictado por voz | “Marca URUS, prenda short, código N115, 18 docenas”. Al detener el micrófono, el formulario se completa solo. |
| Pistola lectora | USB o Bluetooth en modo teclado. Funciona en **toda la app**, aunque el cursor no esté en un campo. Cada lectura suma, resta o cuenta según la configuración. |
| Cámara | Lee códigos de barras y QR (Android, iPhone y PC). |
| Etiquetas | Code 128 o QR. Rollo térmico (50×25, 40×30, 60×40, 100×50 mm) u hoja A4 (24, 40 o 10 por hoja). Copias por producto o una por unidad en stock. |
| Inventario | Búsqueda, filtros, alertas de stock mínimo, +1/−1 rápido, edición y acciones masivas. |
| Historial | Todos los movimientos, filtrables y exportables. |
| Nube | Cuenta con usuario y contraseña. El admin aprueba cada cuenta. Sincroniza entre dispositivos. |
| Admin | `admin.html`, protegido con contraseña: aprobar, deshabilitar, eliminar y cambiar contraseñas. |
| Sin conexión | Funciona offline; los cambios se suben solos al volver internet. |
| Exportar | Excel, CSV y copia JSON. Importar con vista previa. |

---

## 1 · Configurar Supabase (una sola vez)

1. Entrá a <https://supabase.com> → **New project** (plan Free). Elegí una región cercana (São Paulo) y anotá la contraseña de la base.
2. Abrí `supabase/schema.sql` de este proyecto y **cambiá la clave de administrador**. Buscá esta línea en la sección 6:
   ```sql
   values ('admin_hash', extensions.crypt('CAMBIA-ESTA-CLAVE', ...
   ```
   Reemplazá `CAMBIA-ESTA-CLAVE` por tu clave. Igual, la primera vez que entres a `admin.html` te va a pedir que la cambies.
3. En Supabase: **SQL Editor** → **New query** → pegá **todo** el contenido de `supabase/schema.sql` → **Run**. Tiene que decir *Success. No rows returned*.
4. Andá a **Project Settings → API** (o **Data API / API Keys**) y copiá:
   - **Project URL**, por ejemplo `https://abcdxyz.supabase.co`.
   - La clave pública **anon** (empieza con `eyJ…`) o **publishable** (empieza con `sb_publishable_…`).
   - ⚠️ **Nunca** uses la clave `service_role` ni la `secret`.
5. Abrí `js/config.js` y completá:
   ```js
   SUPABASE_URL: 'https://abcdxyz.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOi...tu-clave-anon...',
   ```

El SQL se puede volver a ejecutar sin perder datos (por ejemplo, después de una actualización).

### Aviso automático por WhatsApp (opcional, gratis)

Cada usuario nuevo ve un botón **“Avisar al administrador”**, que abre WhatsApp con un mensaje para vos. Eso funciona sin configurar nada.

Si además querés que te llegue un mensaje **automático** cuando alguien se registra:

1. Agendá el número de CallMeBot que figura en <https://www.callmebot.com/blog/free-api-whatsapp-messages/>.
2. Enviale por WhatsApp: `I allow callmebot to send me messages`. Te responde con tu **API key**.
3. Entrá a `admin.html` → **Aviso automático por WhatsApp** → pegá la key → **Guardar** → **Enviar prueba**.

---

## 2 · Subir a GitHub y Vercel

Si el repositorio ya está conectado a Vercel, alcanza con hacer commit y push:

```bash
git add -A
git commit -m "StockVoz 6: nube Supabase, escáner, etiquetas y panel admin"
git push origin main
```

Vercel publica automáticamente en 1 o 2 minutos.

Si es la primera vez: en <https://vercel.com> → **Add New → Project** → importá el repositorio de GitHub → Framework **Other** → **Deploy**. No hace falta comando de build.

Después de publicar:

1. Abrí `https://tu-app.vercel.app/admin.html` → ingresá con la clave del paso 1 → elegí tu clave definitiva.
2. Abrí la app → **Cuenta y nube** → **Crear cuenta** con un usuario de prueba.
3. En `admin.html`, aprobalo. Ingresá con ese usuario: el chip de arriba tiene que decir **“En la nube”**.

> Si cambiás algo y algún celular sigue mostrando la versión anterior, cerrá y volvé a abrir la app. Para forzar la actualización en todos los dispositivos, subí el número `VERSION` en `sw.js`.

---

## 3 · Uso diario

- **Tarea actual** (Panel): Entrada, Salida, Inventario… se aplica a todo lo que cargues.
- **Escanear** (o la tecla **F2**): elegí *Entrada / Salida / Conteo* y la cantidad por lectura, y disparale a los productos.
  - Si el código no existe, la app te pide los datos o lo crea según lo que configures.
  - **Conteo** sirve para inventariar: la primera lectura de cada producto reinicia su stock y las siguientes suman.
  - Cada lectura se puede **revertir** desde la lista de la sesión.
- **Etiquetas**: elegí productos (o generá códigos nuevos), el tipo y el tamaño, y tocá **Imprimir**. En la ventana de impresión: márgenes **Ninguno** y escala **100 %**.
- **Deshacer**: botón ↶ arriba o **Ctrl+Z**.
- Atajos: **/** busca en el inventario, **F2** abre el escáner.

### Pistola lectora
Funciona con cualquier pistola en **modo teclado (HID)** que mande **Enter** al final, que es la configuración de fábrica de casi todas. Code 128, EAN, UPC y Code 39 las lee cualquier pistola. Para leer **QR** hace falta una pistola **2D** (o usar la cámara).

---

## 4 · Consumo del plan gratuito de Supabase

La app está pensada para gastar lo mínimo:

- **No usa** Supabase Auth, Realtime, Storage ni Edge Functions: solo la base de datos.
- **Una fila por usuario** con todo su inventario. 1.000 productos ocupan unos 250 KB.
- Los cambios se **agrupan**: aunque escanees 100 productos seguidos, se sube **una sola vez**, 5 segundos después del último movimiento.
- Al volver a la app solo pregunta *“¿cambió algo?”*. Si no hubo cambios, la respuesta pesa unos pocos bytes.
- En la nube se guardan los **últimos 1.000 movimientos** del historial.
- El panel admin muestra cuánto ocupa la base, sobre los 500 MB gratis.

Podés ajustar estos valores en `js/config.js`: `SYNC_DELAY_MS`, `CLOUD_HISTORY_LIMIT` y `PULL_INTERVAL_MS`.

> Supabase pausa los proyectos gratuitos que pasan **7 días sin uso**. Si pasa, entrá al panel de Supabase y tocá **Restore**: los datos se conservan.

### Seguridad
- Las contraseñas se guardan cifradas con bcrypt. Nunca viajan ni se guardan en texto plano.
- Las tablas están cerradas: desde la API pública solo se puede usar a través de las funciones, que validan la sesión.
- Una cuenta se bloquea 15 minutos después de 5 intentos fallidos. Lo mismo pasa con el panel admin.
- Una cuenta pendiente o deshabilitada no puede leer ni guardar datos.

---

## 5 · Opciones (`js/config.js`)

| Opción | Para qué |
|---|---|
| `REQUIRE_LOGIN: false` | Cualquiera usa la app en modo local; la nube requiere una cuenta aprobada. |
| `REQUIRE_LOGIN: true` | Nadie entra a la app sin una cuenta aprobada por vos. |
| `ADMIN_WHATSAPP` | Tu número: botón de contacto y avisos de cuentas nuevas. |

---

## Estructura

```text
index.html              App
admin.html              Panel de administración
css/styles.css          Diseño (tema claro/oscuro)
js/config.js            ← Configuración (Supabase, WhatsApp)
js/app.js               Interfaz y navegación
js/store.js             Inventario, historial y deshacer
js/cloud.js             Cuentas y sincronización con Supabase
js/voice.js             Dictado e interpretación de voz
js/scanner.js           Pistola lectora y cámara
js/labels.js            Etiquetas con código de barras y QR
js/io.js                Excel, CSV y JSON
js/admin.js             Lógica del panel admin
supabase/schema.sql     ← Pegar en el SQL Editor de Supabase
sw.js                   Modo sin conexión
assets/creador.jpg      Foto del creador
icons/                  Ícono de la app e íconos de la interfaz
```

Los datos que los usuarios ya tenían en la versión 5 se conservan: la app usa el mismo lugar de guardado en el navegador.
