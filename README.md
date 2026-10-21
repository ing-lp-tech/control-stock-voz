# StockVoz v5.3

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
