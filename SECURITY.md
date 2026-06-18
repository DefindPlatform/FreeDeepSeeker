# Security Policy

FreeDeepseekAPI is designed as a local-first developer tool. The default server binds to `127.0.0.1`. A non-loopback `HOST` is refused unless `FREEDEEPSEEK_API_KEY` is configured.

## Safe operation

- Keep `deepseek-auth.json`, `.env`, cookies, tokens, and generated `.deepseek-agent/` state out of version control.
- Prefer coding-agent mode `ask` for valuable repositories.
- Treat `full` mode as local code execution through the configured program allowlist.
- Do not expose port 9655 to a network without a strong API key, firewall rules, TLS termination, and an exact `CORS_ORIGIN` where browser access is needed.
- Run untrusted repositories in a disposable container or low-privilege virtual machine.

## Protected data

The coding agent blocks common secret files and private-key formats from model access by default. `allowProtectedPaths` should remain `false`. Child-process environments are filtered, but project scripts can still access files available to the operating-system account.

## Reporting

Do not include authentication files, cookies, tokens, private prompts, or proprietary source code in public reports. Provide a minimal reproduction and affected version privately to the maintainer.
