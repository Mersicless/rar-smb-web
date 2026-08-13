# RAR SMB Web

Aplicativo web en Node.js para:

- Descargar archivos desde una URL.
- Extraer automaticamente archivos comprimidos compatibles, como `.rar`, `.zip` o `.7z`.
- Ver y gestionar el repositorio de descargas.
- Renombrar archivos o carpetas.
- Borrar archivos o carpetas que no se necesitan.
- Seleccionar archivos o carpetas y transferirlos a un servidor SMB.
- Ver barras de progreso para descarga/extraccion y transferencia.

## Uso local

Requisitos:

- Node.js 20 o superior.
- `unrar` para extraer archivos `.rar` grandes. `7zip` y `unar` quedan como respaldo para otros formatos.
- `smbclient` para transferir por SMB.

En Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y unrar 7zip unar smbclient
```

Instalar y ejecutar:

```bash
npm install
npm start
```

Abrir:

```text
http://localhost:3000
```

Por defecto la carpeta gestionada es:

```text
./downloads
```

Puedes cambiarla con:

DOWNLOAD_DIR=/ruta/descargas 
```

## Docker

El contenedor instala `unrar`, `7zip`, `unar` y `smbclient`. La carpeta `./downloads` queda montada dentro del contenedor como `/downloads`.

```bash
docker compose up -d --build
```

Luego abre:

```text
http://localhost:3000
```

Para usar otra carpeta de descargas en la maquina host, cambia el volumen en `docker-compose.yml`:

```yaml
volumes:
  - /ruta/en/la/maquina:/downloads
```

## Ruta SMB

En la pantalla de transferencia usa este formato:

```text
//servidor/recurso/carpeta/opcional
```

Ejemplos:

```text
//192.168.X.XX/carpeta/carpeta2/salida
//mi-servidor/Compartido/Entregas
```

Si tu servidor SMB usa dominio o workgroup, escribe ese valor en el campo `Dominio`; si no, dejalo vacio.

## Notas

- El gestor de archivos solo puede listar y borrar dentro de la carpeta configurada como `DOWNLOAD_DIR`.
- Los archivos de video como `.mkv` se descargan sin intentar extraerlos.
- La contraseña solo es necesaria cuando el archivo descargado es un comprimido que debe extraerse.
- La transferencia SMB calcula el progreso por archivos completados y tamaño acumulado.
- Si seleccionas un archivo individual, se transfiere solo ese archivo a la ruta SMB indicada.
- Si seleccionas una carpeta, se transfiere esa carpeta con su estructura interna y archivos.
- Las contraseñas se usan para el proceso solicitado y no se guardan en archivos.
