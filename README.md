# Revisión de pedidos OXS

App web para revisar pedidos escaneando códigos de barra desde el celular.

## Archivos

- `index.html`: pantalla de la app (se publica con GitHub Pages).
- El motor (Google Apps Script) no se guarda en este repositorio público: vive solo en el proyecto "Revisión de pedidos OXS" de Apps Script.

## Publicar en GitHub Pages

1. Subir `index.html` a la raíz del repositorio.
2. Settings > Pages > Deploy from a branch > `main` / `(root)` > Save.
3. La app queda en `https://<organizacion>.github.io/<repositorio>/`.

## Configuración

La dirección del motor está en `index.html`, en la constante `API_URL`.
Las claves (BSALE_TOKEN, CLAVE_APP y otras) se configuran solo en las Propiedades del script de Apps Script; no van en este repositorio.
