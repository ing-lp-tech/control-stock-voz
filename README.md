# StockVoz v5.12

Aplicación web estática para controlar cantidades por voz o manualmente. No requiere backend ni base de datos. Los datos quedan guardados en el navegador/dispositivo.

## Archivos del proyecto
- `index.html`: aplicación.
- `manifest.webmanifest`: instalación como PWA.
- `sw.js`: caché offline de archivos locales.
- `icons/icon.svg`: icono.
- `vercel.json`: configuración para publicar en Vercel.

## Publicar / actualizar en GitHub y Vercel
1. Descomprimí el ZIP.
2. Subí todos los archivos y la carpeta `icons` a la raíz de tu repositorio GitHub, conservando la estructura.
3. Si el proyecto ya está conectado a Vercel, hacé commit/push a la rama configurada; Vercel desplegará la actualización automáticamente. Si es la primera vez, importá el repositorio desde Vercel.
4. Abrí la URL HTTPS y probá la aplicación. Micrófono y cámara requieren permisos del navegador.

## Funciones
- Dictado de un producto por vez, con pantalla editable de revisión antes de guardar.
- Categorías de stock: inventario general, entrada de mercadería, salida de mercadería, stock de local, depósito, producción, transferencia, ajuste u otro.
- Modos de movimiento (sumar/restar) y conteo físico (establecer cantidad exacta).
- Unidades opcionales: unidades, docenas, cajas, paquetes, pares, rollos, kg, g, metros, litros u otra unidad. Las docenas se convierten a 12 unidades. Para evitar mezclar medidas, cada SKU conserva una unidad de stock y la app avisa si se intenta usar otra.
- Historial, deshacer temporal, edición individual y múltiple, escaneo de códigos cuando el navegador lo admite.
- Importar XLSX/CSV/JSON con vista previa; exportar XLSX, CSV y copia JSON.
- Recordatorio local de respaldo cada 7 días y PWA instalable.

## Importante
- La app no sincroniza datos entre dispositivos ni usuarios. Exportá una copia JSON periódicamente.
- Los totales globales no deben interpretarse como una sola magnitud si mezclás unidades distintas (por ejemplo cajas y kilogramos).
- Reconocimiento de voz y escáner dependen de las capacidades del navegador. Excel requiere internet para cargar la librería desde CDN; CSV/JSON se generan localmente.
- Probá primero con datos ficticios y comprobá una copia de seguridad antes de actualizar una instalación con datos importantes.


## Correcciones v5.4
- La cantidad puede decirse como “20 docenas” o “docenas 20”; se prioriza el número asociado a la unidad y no los dígitos del SKU.
- Se conserva la unidad de dictado para mostrar, por ejemplo, 20 docenas = 240 unidades.
- Se elige el tipo de tarea una sola vez en el selector superior y se aplica a todos los productos cargados durante esa tarea.
- Se quitó la columna independiente de tipo de stock de la tabla; el tipo se muestra como información secundaria en la cantidad registrada.


## Promoción del creador y contacto

La interfaz incluye una sección promocional de **Ingeniero Emprendedor** para apps y sistemas, pizarras digitalizadoras, plotters e innovación textil.

Para activar el botón de WhatsApp, abrí `index.html` y buscá esta línea al comienzo del script principal:

```js
window.CREATOR_WHATSAPP = '';
```

Reemplazá el texto vacío por el número internacional, solo dígitos, sin `+`, espacios ni guiones. Ejemplo ficticio: `window.CREATOR_WHATSAPP = '54911XXXXXXXX';`. Luego subí el cambio a GitHub y esperá el despliegue de Vercel. El botón abre WhatsApp con un mensaje inicial sobre tus servicios.


WhatsApp de contacto de Ingeniero Emprendedor: +54 9 11 6202-1005. El botón abre un mensaje predeterminado que comienza con “Hola, vengo de la app de stock y quiero…”.


### Corrección v5.10 de cantidad por voz
- Si se detecta un número después de una unidad (por ejemplo, “docenas 16”), prioriza ese número frente a otro número antes de la unidad.
- Si no existe cantidad después de la unidad, admite “16 docenas”.
- Confirmá siempre la cantidad en la pantalla de revisión antes de guardar, ya que el reconocimiento de voz del navegador puede transcribir palabras o números incorrectamente.


### Corrección de voz v5.10
El SKU se captura completo desde “código” hasta la unidad de cantidad y se eliminan los espacios del código. Por ejemplo, “código 15 15 docenas 16” produce SKU `1515` y cantidad `16` docenas; “código K 1515 docenas 16” produce SKU `K1515` y cantidad `16` docenas. Revisá siempre la pantalla de confirmación antes de guardar.


### Corrección v5.10 para dictado en celulares
- El texto de voz se reconstruye a partir de los resultados actuales del navegador, en lugar de ir concatenando ciegamente segmentos finales repetidos.
- Se fusionan segmentos con solapamiento para reducir frases/campos duplicados cuando el motor móvil reenvía hipótesis acumulativas.
- La extracción del SKU contempla fragmentos repetidos después de “código”, para reconstruir identificadores como `T1212`; la cantidad posterior a “docenas” sigue teniendo prioridad.
- La precisión final sigue dependiendo del motor de reconocimiento de voz del navegador y del audio; revisar la pantalla de confirmación antes de guardar.


## Agregar tu propia imagen JPEG (v5.11)

La aplicación tiene un espacio adaptable para una imagen destacada, visible tanto en computadora como en celular. Para agregarla:

1. Elegí tu imagen y guardala/exportala como **JPEG** (extensión `.jpg`).
2. Cambiale el nombre exactamente a **`imagen-app.jpg`** (todo en minúscula).
3. En la carpeta del proyecto, colocá `imagen-app.jpg` **al mismo nivel que `index.html`**, no dentro de `icons` ni de otra carpeta. La estructura debe quedar así:

```text
StockVoz_v5_11/
├── index.html
├── imagen-app.jpg   ← SUBÍ TU IMAGEN AQUÍ
├── manifest.webmanifest
├── sw.js
├── vercel.json
└── icons/
    └── icon.svg
```

4. Subí `imagen-app.jpg` a la raíz del repositorio GitHub, en la misma carpeta donde está `index.html`, junto con los archivos actualizados. Confirmá el cambio en `main` y esperá el despliegue de Vercel.
5. Abrí la app y recargala. Si el celular muestra una versión anterior, cerrá y volvé a abrir la app o recargá el sitio en el navegador.

**Importante:** respetá exactamente el nombre `imagen-app.jpg`. Si tu archivo es `.jpeg`, renombrarlo no convierte su formato; exportalo realmente como JPEG y usá el nombre indicado. La imagen mantiene su proporción y se adapta al ancho de la pantalla. Si el archivo no está presente, la aplicación muestra un recuadro de ayuda en su lugar.


## Modo sin conexión (v5.12)

StockVoz funciona como PWA instalable y guarda el inventario e historial en el almacenamiento local del navegador/dispositivo. El service worker guarda la interfaz principal para volver a abrirla sin Internet después de haber visitado la app al menos una vez con conexión. También intenta guardar `imagen-app.jpg` si existe al instalar/actualizar la app.

### Cómo usarla offline
1. Publicá los archivos en GitHub y esperá que Vercel termine el despliegue.
2. Abrí la app una vez con Internet desde cada dispositivo y esperá unos segundos a que cargue por completo.
3. Instalá la app desde el navegador (botón **Instalar**, si aparece, o “Agregar a pantalla de inicio” en el móvil).
4. Abrí StockVoz desde su icono. Una vez que el contenido esté almacenado, las funciones de inventario y los datos locales pueden usarse sin conexión.
5. Exportá periódicamente una copia JSON: los datos quedan en ese dispositivo/navegador y no se sincronizan automáticamente entre PC y celular.

### Límites del modo offline
- **Dictado por voz:** el reconocimiento depende del navegador y del sistema operativo. Chrome/Android o el navegador de PC pueden enviar audio a un servicio externo; no se garantiza el reconocimiento de voz sin Internet. Si no funciona offline, usá la escritura manual.
- **Excel XLSX:** esta versión carga la biblioteca Excel desde un CDN, por lo que importar/exportar XLSX puede requerir Internet. CSV y copias JSON son las opciones recomendadas sin conexión.
- WhatsApp, actualización de la app y el primer acceso requieren conexión.
- El JPEG personalizado se cachea si está presente cuando se instala/actualiza la app; si lo subís después, conectate una vez y recargá.
- La app requiere una primera apertura online para instalar el caché. Si borrás los datos del navegador, también podés borrar la app offline y los datos guardados.
