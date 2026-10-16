FROM --platform=linux/amd64 node:24.22.0-bookworm-slim@sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7
RUN npm install --global --ignore-scripts @anthropic-ai/claude-code@2.1.301 && npm cache clean --force
RUN ln -sf /usr/local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude /usr/local/bin/claude
RUN mkdir -p /worker /empty /bundle && chmod 555 /empty /bundle
COPY worker/settings.json worker/mcp.json worker/review-prompt.md /worker/
COPY worker/managed-settings.json /etc/claude-code/managed-settings.json
WORKDIR /empty
USER 1000:1000
ENTRYPOINT ["claude"]
