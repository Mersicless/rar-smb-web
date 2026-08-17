FROM node:22-bookworm-slim

WORKDIR /app

RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates unrar 7zip unar smbclient \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY public ./public
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV DOWNLOAD_DIR=/downloads

EXPOSE 3000

CMD ["npm", "start"]
