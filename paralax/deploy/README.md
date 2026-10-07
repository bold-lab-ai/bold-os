# Hosting a Paralax meeting from your Mac

One command starts the server with seat tokens and prints two links. The public address is
https://meet.chrisantha.uk, served through the named Cloudflare Tunnel that already runs on
this Mac for chrisantha.uk (the one hosting the VERA study); nothing else needs starting.

```sh
cd paralax
deploy/meeting.sh 10            # 10 seats; a fresh session and new tokens
deploy/meeting.sh 10 quick      # instead: a temporary random trycloudflare.com address
```

It prints:

- **the join link** to send to people. Each click takes the next free seat and opens that
  person's own chat. Ten seats means the eleventh click is told to ask the host.
- **the researcher link**, for you only: every chat, what each assistant read, the mode
  switch, the shared-problem field, and the list of seats with who took them. Hover a seat to
  copy its direct link if someone loses theirs.

Set the shared problem in the researcher view before people join. Stop with `deploy/stop.sh`.

## Before the meeting

1. Put your Gemini key in `paralax/.env` as `GEMINI_API_KEY=...` (that file is gitignored and
   never read by anything but the server), or export it in the shell that runs the script.
2. Make sure `deploy/bin/cloudflared` exists and runs: `deploy/bin/cloudflared --version`.
   If not, download `cloudflared-darwin-arm64.tgz` from
   https://github.com/cloudflare/cloudflared/releases, unpack it into `deploy/bin/`, and
   `chmod +x deploy/bin/cloudflared`. The folder is gitignored.
3. Start the meeting script **ten minutes early**. A quick tunnel's random address takes one to
   three minutes to become reachable after the script prints it. Open the researcher link
   yourself first; when it loads, the join link is ready to send.
4. Keep the laptop awake and on the network for the whole meeting. The tunnel is an outbound
   connection from your Mac; nothing is opened inbound, and the session ends when you stop it.

## What people see

Only their own chat, with the shared problem at the top, read-only. Their assistant draws on
what the others type when it bears on what they are doing, and credits them by name. Nobody
sees anyone else's conversation except you, in the researcher view. Say this out loud at the
start: everyone's assistant reads what everyone types.

## How the address is wired (done on 7 Oct 2026)

`~/.cloudflared/config.yml` on this Mac runs the named tunnel `vera-study` as a launchd service
(`uk.chrisantha.vera-tunnel`, kept awake with caffeinate). It got one more ingress rule:

```yaml
  - hostname: meet.chrisantha.uk
    service: http://localhost:8808
```

and a DNS record created with `cloudflared tunnel route dns vera-study meet.chrisantha.uk`.
The tunnel credentials stay in `~/.cloudflared`, outside the repository. To move the address
or add another, edit that file and restart the service:
`launchctl kickstart -k gui/$(id -u)/uk.chrisantha.vera-tunnel` (the other hostnames on the
tunnel drop for a few seconds). The dashboard shows it under Zero Trust, Networks, Tunnels.

A quick tunnel (`deploy/meeting.sh 10 quick`) must be told to ignore that config, which the
script does with `--config deploy/logs/quick.yml`; otherwise the config's catch-all 404 rule
wins and the public address answers 404.

## What is and is not protected

- Seats and the researcher view are behind random tokens in the links. Anyone with the join
  link can take a seat until the seats run out; anyone with the researcher link sees everything.
  Send the researcher link to no one.
- Traffic is HTTPS between browsers and Cloudflare, and inside the tunnel to your Mac.
- There is no login and no rate limit beyond one reply in flight per seat. This is a meeting
  tool for a known group, not a public service.
- The session log is `paralax/sessions/<name>.jsonl` on your Mac; tokens are in
  `paralax/sessions/tokens.json` (mode 600). Both are gitignored.

## If something goes wrong

- **The join link shows "ask the host" immediately:** the seats are all taken, or the tokens
  were re-minted after the link was sent. Start again with `deploy/meeting.sh` and resend.
- **The public address does not load:** wait two more minutes; then check
  `deploy/logs/tunnel.log` for "Registered tunnel connection". If your network blocks the
  tunnel entirely, run `deploy/meeting.sh` from a phone hotspot, or use the named tunnel.
- **Replies are slow or fail:** Gemini congestion. The server retries across two models;
  waits of 10 to 20 seconds happen. `deploy/logs/server.log` shows every call.
- **You need to run it on the lab network only:** skip the tunnel, start
  `python3 server.py --new --new-tokens --panes 10 --host 0.0.0.0` and give people
  `http://<your-Mac's-IP>:8808/join?room=<room token from the log>`.
