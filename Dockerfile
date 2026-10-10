FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Fail the build, not the first request, if the install was incomplete.
RUN npm ci --omit=dev \
 && node -e "import('@modelcontextprotocol/sdk/server/index.js').then(() => console.log('sdk ok'))"
COPY src ./src
# Smithery supplies the start command from smithery.yaml.
CMD ["node", "src/server.js"]
