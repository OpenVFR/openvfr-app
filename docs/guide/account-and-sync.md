---
title: Account and sync
description: Signing in, passkeys, syncing between devices and deleting your account.
sidebar:
  order: 16
---

## Signing in

You sign in with:

1. **A passkey** (preferred): your device's fingerprint, face or PIN. No
   password to remember.
2. **An email code** (fallback): enter your email, then the 6-digit code
   you receive.

After signing in with a code you can register a passkey from your profile.
On first sign-in you also choose a display name.

There is no password and no payment.

## Your profile

On the web app, open your profile from the account badge (the initials in
the side panel). There you can see your email, change your **display
name**, see and **revoke passkeys**, sign out and delete your account. On
native, the account section at the bottom of Settings has sign out and
delete.

## What syncs

Routes, aircraft profiles, saved places, flight logs and settings sync
between your devices. Rules worth knowing:

- Everything is saved on the device first and uploaded when possible. A
  failed upload stays local and is retried.
- A deletion on one device is carried to the others.
- A row the server refuses for good (too large, or an account limit)
  stays on this device only, with a note that explains why.
- Simulated flight logs are never synced.
- Signing out stops sync, and a different account signing in on the same
  device never uses the previous account's data or token.

## Privacy

Weather, NOTAM and traffic requests go through the OpenVFR server so that
your device does not contact third parties directly. See the
[privacy policy](https://openvfr.org/privacy) for what is stored.

## Delete your account

Choose **Delete account and all data** in your profile (Settings on
native). We email a confirmation link and nothing is deleted until you
click it. The link expires after 24 hours. Deletion removes your account
and all its data: routes, aircraft profiles, places, settings and flight
logs, permanently. You can also use the
[delete account page](https://openvfr.org/delete-account).
