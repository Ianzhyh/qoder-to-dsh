# NOTICE

qoder-to-dsh is an independent, non-official interoperability plugin. It is not
affiliated with Qoder, Alibaba, or DeepSeek.

## Third-party code and protocol research

This project is MIT-licensed. Parts of its behavior and implementation were
adapted from the following MIT-licensed projects:

- **shuishuipingan/qoder2api-hub**
  https://github.com/shuishuipingan/qoder2api-hub
  Copyright (c) 2026
  - Qoder COSY signing (custom Base64, RSA-wrapped session key, AES-CBC
    identity envelope, MD5 Bearer signature), device authorization, token
    refresh, desktop credential import, model catalog mapping, and the
    `agent_chat_generation` request/SSE schema.
  - `lib/baseprompt.json` is vendored from this project (MIT).
- **Liki4/qodercli2api**
  https://github.com/Liki4/qodercli2api
  - Public research notes on Qoder device authorization (PKCE, deviceToken /
    jobToken) and SSE envelopes.
- **bzym2/QoderGateway**
  https://github.com/bzym2/QoderGateway
  - Cross-check of the newer Bearer `/model/v1/chat/completions` endpoint and
    protocol documentation.
- **Ianzhyh/workbuddy-to-dsh**
  https://github.com/Ianzhyh/workbuddy-to-dsh
  Copyright (c) 2026 Ianzhyh
  - DSH native adapter contract usage (`providerInfo`, `providerRetryPolicy`,
    `listModels`, `resolveModel`, `prepareCall`, `stream`), DSH StreamChunk
    mapping, message sanitization, usage bucket math, slot registration, and
    panel interaction patterns. The implementation here is a single-process
    redesign, not a copy of that project's bridge/dashboard architecture.
- **Qoder daily campaign protocol research**
  - [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)
    and [L0NE-6/Qoder-Daily](https://github.com/L0NE-6/Qoder-Daily)
  - Cross-checked the unofficial `campaigns` / `claim` endpoint shape and the
    use of the locally installed `runtime-info` UMID component for device
    headers. No code was copied; the implementation here re-reads the local
    client identity and keeps all tokens in memory.

The Qoder RSA public key and COSY protocol constants are reproduced from the
public Qoder client protocol solely to interoperate with the user's own Qoder
account. No private keys, credentials, accounts, or credits are included in
this repository.

## Trademarks

Qoder is a trademark of its respective owner. DeepSeek Harness is a project of
its respective owner. All other trademarks are the property of their owners.

## Use

Use this project only with accounts you are authorized to use, on your own
machine, in accordance with Qoder's terms of service. Do not use it for account
pooling, resale, proxying third-party traffic, or circumventing quotas.
