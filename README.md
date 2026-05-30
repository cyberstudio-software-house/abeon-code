# AbeonCode / AbeonCloud

Monorepo for AbeonCode (desktop AI-CLI session manager) and AbeonCloud (remote
control of those sessions from mobile, relayed through Centrifugo).

## Sub-projects

| Directory      | What it is                                              | Status   |
|----------------|---------------------------------------------------------|----------|
| `DesktopApp/`  | Tauri 2 + React 19 desktop app                          | active   |
| `MobileApp/`   | React Native / Expo mobile client                       | planned  |
| `CloudService/`| Auth/pairing + command-authorization microservice       | planned  |

Design and plans live in [`docs/superpowers/`](docs/superpowers/).

## Getting started (desktop)

```bash
cd DesktopApp
npm install
npm run tauri dev
```
