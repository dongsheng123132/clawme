# ClawMe iOS

This directory contains the source code for the **ClawMe Native iOS App**.

## How to Run

Since there is no `.xcodeproj` file (binary), you need to create a new project in Xcode and drag these files in.

1.  **Open Xcode**.
2.  Create a **New Project** -> **iOS** -> **App**.
3.  Name it: `ClawMe`.
4.  Interface: **SwiftUI**.
5.  Language: **Swift**.
6.  Once created, **delete** the default `ContentView.swift` and `ClawMeApp.swift` created by Xcode.
7.  **Drag and Drop** the `ClawMe` folder from this directory into your Xcode project navigator.
8.  Ensure "Copy items if needed" is checked.

## Architecture

*   **App Entry**: `ClawMeApp.swift`
*   **UI**: `Views/ContentView.swift` (Main Dashboard)
*   **Services**: `Services/ConnectionManager.swift` (Handles WebSocket/Push)
*   **Models**: `Models/Instruction.swift` (Parses JSON commands)

## Features (Planned)

*   [ ] **Voice Mode**: "Hey Siri, Ask ClawMe..."
*   [ ] **Shortcuts**: App Intents provider
*   [ ] **Push Notifications**: APNs integration
