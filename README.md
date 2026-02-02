# BruddiBooster v1 🚀

![Built by Gemini](https://img.shields.io/badge/Built%20by-Gemini%20AI-4285F4?style=for-the-badge&logo=google&logoColor=white)
![Dev Time](https://img.shields.io/badge/Dev%20Time-Few%20Hours-success?style=for-the-badge)
![Security](https://img.shields.io/badge/Security-AES--256--CBC-red?style=for-the-badge&logo=auth0)

**A self-hosted, web-based Steam Hour Booster with 2FA protection, bulk account management, and military-grade encryption for your data.**

---

## ✨ Showcase

### 📊 Dashboard & Overview
| **Main Dashboard** | **Mobile View** |
|:---:|:---:|
| ![Dashboard Preview](https://i.imgur.com/cmiF90W.png) | ![Mobile Preview](https://i.imgur.com/XDnbyrZ.png) |
| *Real-time stats and account management* | *Fully responsive design* |

### 🛠️ Advanced Tools
| **Proxy Manager** | **Free Games Selector** |
|:---:|:---:|
| ![Proxy Manager](https://i.imgur.com/6gxqkUD.png) | ![Free Games](https://i.imgur.com/Jwl5IQo.png) |
| *Bulk import and test proxies* | *Add free games to library easily* |

### ⚙️ Configuration
| **Settings & Security** | **Game Bundles** |
|:---:|:---:|
| ![Settings Page](https://i.imgur.com/M5cEBe6.png) | ![Bundles](https://i.imgur.com/vYxC9DB.png) |
| *2FA setup and password management* | *Manage game presets* |

---

## 🤖 About This Project

This entire application—from the backend server logic to the frontend design and security implementation—was generated **100% by Google's Gemini AI** in just a few hours.

**Note:** I am by no means a professional developer. I had the idea, and AI did the heavy lifting. While the code is functional and tested, I will do my best to maintain and improve it as I learn.

If you encounter any bugs or have feature suggestions, please feel free to **open an issue** in the [Issues tab](../../issues).

---

## 🔐 Security & Privacy

Your data security is the top priority of this project.

* **AES-256 Encryption:** All Steam passwords and Shared Secrets are encrypted using `AES-256-CBC` before being saved to the disk. Even if someone gets access to your server files, they cannot read your Steam credentials without the `secret.key`.
* **Local Storage Only:** No data is sent to any external cloud. Everything stays on your own server/VPS.
* **Git Safety:** The project is configured to strictly ignore all sensitive files (`users.json`, `accounts/`, `secret.key`), making it safe to fork and update.

---

## 🔥 Key Features

* **Secure Dashboard:** Web interface protected by Login + Google Authenticator (2FA).
* **Account Management:** Add, Edit, and Delete Steam accounts easily.
* **Bulk Import & Edit:** Add multiple accounts at once and mass-edit settings like proxies, avatars, or privacy.
* **Proxy Manager:** Assign individual proxies to accounts to prevent IP bans, with a built-in proxy checker.
* **Game Bundles & Rotation:** Create game presets and idle more than 32 games by automatically rotating them every hour.
* **Profile Editor:** Change your Avatar, Nickname, Real Name, Custom URL, and Privacy Settings directly from the dashboard.
* **Discord Notifications:** Get notified via Webhook when an account needs a Steam Guard code, hits a rate limit, or disconnects.
* **Auto-Accept Friends:** Optional setting to automatically accept incoming friend requests.
* **My Library Selector:** Automatically fetches your owned games for easy selection—no need to look up App IDs manually.
* **Auto-Start:** Configurable option to automatically start specific accounts when the server boots.
* **Panic Button:** Emergency switch to stop all bots immediately.
* **Smart Logging:** Detailed error reporting (e.g., Incorrect Password, Steam Guard required) saved directly to the dashboard with tooltip hints.
* **Visual Status:** Clear indicators for running bots, 2FA status, and error messages.
* **Category System:** Organize accounts into "Main", "Smurfs", "Storage", etc.
* **Live Logs:** Real-time log streaming via WebSockets.
* **Mobile Ready:** Fully responsive design for mobile management.
* **Dark/Light Mode:** Toggle between themes in settings.

---

## 💻 System Requirements

BruddiBooster is very lightweight, but requirements depend on how many accounts you plan to boost.

| Component | Minimum (1-5 Accounts) | Recommended (10+ Accounts) |
| :--- | :--- | :--- |
| **OS** | Linux (Ubuntu/Debian) or Windows | Linux (Ubuntu 20.04+) |
| **RAM** | 512 MB | 1 GB+ |
| **CPU** | 1 vCore | 2 vCores |
| **Node.js** | v16.0.0 or higher | v18.0.0 (LTS) |
| **Storage** | 200 MB free space | 500 MB free space |

---

## 🛠️ Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/wiktorelka/BruddiBooster.git
    cd BruddiBooster
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Start the Server**
    ```bash
    node server.js
    ```

4.  **Access the Panel**
    Open your browser and go to: `http://localhost:3000`

---

## 🔑 Default Login

When you run the app for the first time, a `users.json` file is generated automatically.

* **Username:** `admin`
* **Password:** `password`

**⚠️ IMPORTANT:** Go to the **Settings** tab immediately to change your password and enable 2FA!

---

## 📂 Project Structure

* `server.js` - The main backend logic (Node.js/Express).
* `public/` - The frontend HTML/CSS/JS.
* `accounts/` - Stores **Encrypted** account data (Local only, ignored by Git).
* `users.json` - Stores **Encrypted** panel user credentials (Local only, ignored by Git).

---

## ⚠️ Disclaimer

This tool is for educational purposes. Using hour boosters may violate Steam's Terms of Service. Use at your own risk.

---

# 📝 Project Roadmap & Todo

Here are the features planned for future updates of BruddiBooster.

### 🚀 Upcoming Features
- [x] **Proxy Support:** Ability to assign individual HTTP/SOCKS5 proxies to accounts to prevent IP bans.
- [x] **Auto-Accept Friends:** Configurable rules to auto-accept friend requests.
- [x] **Discord Webhooks:** Send notifications to Discord when an account goes offline or needs a Guard code.
- [x] **Profile Editor:** Edit profile details and privacy settings.
- [x] **Game Rotation:** Idle more than 32 games.
- [ ] **Steam Chat:** View and reply to Steam friends directly from the dashboard.
- [ ] **Docker Support:** Create a `Dockerfile` for easy one-click deployment.

### 🐛 Known Issues
- None at the moment!

---
*Have a suggestion? Open an issue!*