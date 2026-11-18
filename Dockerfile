FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_MODEL_URL
ENV VITE_MODEL_URL=$VITE_MODEL_URL
ARG VITE_SEG_MODEL_URL
ENV VITE_SEG_MODEL_URL=$VITE_SEG_MODEL_URL
RUN npm run build
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
