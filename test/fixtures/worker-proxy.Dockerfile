FROM basic-pr-reviewer-proxy:task5
COPY fake-provider.mjs fake-proxy-entrypoint.sh /fixture/
ENTRYPOINT ["sh", "/fixture/fake-proxy-entrypoint.sh"]
