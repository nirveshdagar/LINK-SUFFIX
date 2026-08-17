FROM nginx:1.25-alpine
COPY fake-ta.conf /etc/nginx/conf.d/default.conf