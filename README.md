# RAR SMB Web

Aplicativo web en Node.js para:

- Descargar archivos desde una URL.
- Extraer automaticamente archivos comprimidos compatibles, como `.rar`, `.zip` o `.7z`.
- Ver y gestionar el repositorio de descargas.
- Renombrar archivos o carpetas.
- Borrar archivos o carpetas que no se necesitan.
- Seleccionar archivos o carpetas y transferirlos a un servidor SMB.
- Ver barras de progreso para descarga/extraccion y transferencia.

## Arquitectura

El backend separa cada responsabilidad dentro de `src/`:

```text
src/
├── config/          # Rutas del proyecto, puerto y host
├── controllers/     # Manejo de request y response
├── routes/          # Definicion de endpoints de Express
├── services/        # Descarga, archivos, RAR, trabajos y SMB
├── middlewares/     # Errores y controladores asincronos
├── utils/           # Validacion, formato y comandos del sistema
├── app.js           # Configuracion de Express
└── server.js        # Arranque del servidor
```

El recorrido habitual de una peticion es:

```text
ruta -> controlador -> servicio -> controlador -> respuesta HTTP
```

`server.js` solo inicia la escucha. `app.js` crea y configura Express, monta las
rutas y registra los middlewares. Los controladores conocen HTTP; los servicios
contienen la logica del programa y no dependen de `request` ni de `response`.

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

```bash
DOWNLOAD_DIR=/ruta/descargas npm start
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
//192.168.xx.xxx/Carpeta-X/Carpeta-Z
//mi-servidor/Compartido/Entregas
```

Si tu servidor SMB usa dominio o workgroup, escribe ese valor en el campo `Dominio`; si no, dejalo vacio.

## Notas

- El gestor de archivos solo puede listar y borrar dentro de la carpeta configurada como `DOWNLOAD_DIR`.
- Los archivos de video como `.mkv` se descargan sin intentar extraerlos.
- La contrasena solo es necesaria cuando el archivo descargado es un comprimido que debe extraerse.
- La transferencia SMB calcula el progreso por archivos completados y tamano acumulado.
- Si seleccionas un archivo individual, se transfiere solo ese archivo a la ruta SMB indicada.
- Si seleccionas una carpeta, se transfiere esa carpeta con su estructura interna.
- Las contrasenas se usan para el proceso solicitado y no se guardan en archivos.
