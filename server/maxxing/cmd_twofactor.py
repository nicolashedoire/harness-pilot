"""`pilot 2fa` - two-step sign-in with Telegram or an authenticator app, from the server (the way out when Telegram
does not answer or the phone with the app is lost).

    pilot 2fa status              on / off, Telegram linked or not, authenticator app on or not
    pilot 2fa off                 password only again: Telegram and the app (every trusted browser is forgotten)
    pilot 2fa forget-browsers     every browser asks again at its next sign-in

Turning it on: Settings -> Security (authenticator app) or Settings -> Telegram (approval in Telegram).
"""
from __future__ import annotations

import json

from . import cli


def _configure(p) -> None:
    sub = p.add_subparsers(dest="action")
    st = sub.add_parser("status", help="on / off, Telegram linked or not, authenticator app")
    st.add_argument("--json", action="store_true")
    sub.add_parser("off", help="password only again (the way out when Telegram does not answer or the phone is lost)")
    sub.add_parser("forget-browsers", help="every trusted browser asks again")


def _handler(a) -> int:
    from . import totp, twofactor
    action = a.action or "status"
    if action == "off":
        was, app = twofactor.is_on(), totp.is_on()
        twofactor.set_on(False)
        totp.disable()
        if app:
            twofactor.forget_devices()
        if was:
            twofactor.notify("off_cli")
        print("Two-step sign-in is off (Telegram and authenticator app): the password alone signs in again. "
              "Turn it back on in Settings -> Security." if was or app else "Two-step sign-in was already off.")
        return 0
    if action == "forget-browsers":
        twofactor.forget_devices()
        print("Every browser will ask for the second step (Telegram or the authenticator app) at its next sign-in.")
        return 0
    on, linked, app = twofactor.is_on(), twofactor.available(), totp.is_on()
    if getattr(a, "json", False):
        print(json.dumps({"on": on, "telegram_linked": linked, "active": on and linked, "authenticator": app,
                          "recovery_left": totp.status()["recovery_left"]}))
        return 0
    if app:
        print(f"Authenticator app: on ({totp.status()['recovery_left']} recovery codes left). Way out: pilot 2fa off")
    if on and linked:
        print("Two-step sign-in: on (Telegram approval for every new browser). Way out: pilot 2fa off")
    elif on:
        print("Two-step sign-in: on, but no Telegram chat is linked - not asked until one is linked again.")
    else:
        print("Two-step sign-in: off" + ("" if linked else " (link Telegram first: Settings -> Telegram)") + ".")
    return 0


cli.register("2fa", "two-step sign-in (Telegram, authenticator app): status, off (way out over SSH), forget-browsers",
             _configure, _handler)
