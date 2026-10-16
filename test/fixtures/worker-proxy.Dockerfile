ARG PROXY_IMAGE
FROM ${PROXY_IMAGE}
COPY fake-provider.mjs fake-proxy-entrypoint.sh /fixture/
ENTRYPOINT ["sh", "/fixture/fake-proxy-entrypoint.sh"]
