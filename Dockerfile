FROM node:22.14.0-alpine AS build

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --only=production

COPY . .

FROM node:22.14.0-alpine

WORKDIR /usr/src/app

COPY --from=build /usr/src/app ./

EXPOSE 3000

CMD [ "node", "index.js" ]