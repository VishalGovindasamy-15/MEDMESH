# Building MedMesh for Android

Two routes to an installable Android build. **EAS Build** (cloud) is the one to
use unless you have a specific reason not to — it produces a signed artifact you
can hand to a hospital without touching a JDK. The local route exists for
air-gapped environments and for debugging the native layer.

The frontend is one Expo/React Native app. The same codebase serves web, Android
and iOS; nothing about the Android build is a fork.

---

## 0. Before you build anything

Two environment variables decide whether the map works in the APK. Read the
"Google Maps keys" section below before your first build — a build made without
them is a working app with a schematic map, which is fine for a demo and wrong
for a pilot.

```bash
cd mobile
npm install
```

Verify the app typechecks and the API is reachable before you spend a build
minute on it:

```bash
npx tsc --noEmit          # must be silent
```

### What was verified when this guide was written

To be clear about provenance, since a build guide that has never been run is
worse than none:

**Checked by running it:**

- `npx expo prebuild --platform android --clean` completes and writes `android/`.
- The generated package/namespace is `in.medmesh.app`, matching the package name
  you must register against your Maps key.
- **Maps key wiring is real.** With `MEDMESH_GOOGLE_MAPS_ANDROID_KEY` set, the
  generated manifest contains
  `<meta-data android:name="com.google.android.geo.API_KEY" android:value="…"/>`.
  With it unset, that entry is **absent entirely** — the app does not boot with a
  placeholder key that fails at runtime. This is the single most common way an
  Expo Maps build goes wrong, and it is handled in `app.config.ts`.
- `react-native-maps` is picked up by React Native autolinking.
- The permissions listed in §5 are exactly what lands in the manifest.
- Gradle 9.3.1 demands JVM 17, with the error text quoted in §7.

**Not checked, and therefore your job:** a completed `assembleDebug` producing an
installable APK. The environment this was written in has two CPU cores, and the
first build spent twenty minutes downloading artifacts before it was stopped. The
instructions are the standard Expo/Gradle path and the steps before compilation
were verified individually, but treat the local-build section as tested in parts,
not end to end. **EAS Build (§3) is the route to prefer** — it is also the route
that produces a signed artifact you can hand to a hospital.

---

## 1. Google Maps keys

Android needs its **own** key. A Maps SDK for Android key is restricted by
package name *and* signing-certificate SHA-1; it is a different key from the web
JavaScript key, and it cannot be shared with iOS.

In [Google Cloud Console](https://console.cloud.google.com/) → *APIs & Services*:

1. Enable **Maps SDK for Android** (and **Directions API** if you want real road
   geometry rather than the labelled estimate).
2. Create an API key, then restrict it:
   - *Application restriction*: **Android apps**
   - *Add package name*: `in.medmesh.app`
   - *Add fingerprint*: the SHA-1 of the keystore you sign with.

Get the SHA-1 for the debug keystore:

```bash
keytool -list -v \
  -keystore ~/.android/debug.keystore \
  -alias androiddebugkey \
  -storepass android -keypass android \
  | grep SHA1
```

For a production build, use the release keystore's SHA-1. With EAS-managed
credentials you can read it back without the keystore file:

```bash
eas credentials -p android
```

> **If you build without a key**, the app still works. `app.config.ts` omits the
> key from the native manifest when it is unset, `extra.nativeMaps` is `false`,
> the native map view is never mounted, and every map surface falls back to the
> schematic renderer — which is labelled as an estimate. Do not ship that to
> dispatch without saying so.

You also need a **web** key if you are serving the browser build. Set
`EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`, restricted by HTTP referrer. It is inlined
into the JS bundle, so referrer restriction is the only thing protecting it.

---

## 2. Point the app at your API

The app resolves its API host automatically for development (same origin on web,
Metro host on device, `10.0.2.2` on the emulator). A **release APK must be told
explicitly**, because there is no Metro server to infer from:

```bash
EXPO_PUBLIC_API_URL=https://api.your-district.example.in
```

Set it as an EAS secret so it never lands in the repository:

```bash
eas secret:create --name EXPO_PUBLIC_API_URL \
  --value https://api.your-district.example.in --scope project
```

The `preview` profile in `eas.json` points at `http://10.0.2.2:8000` for an
emulator talking to a backend on your machine. **A physical phone cannot reach
`10.0.2.2`** — use your machine's LAN address (`http://192.168.x.x:8000`) and
make sure the backend is bound to `0.0.0.0`, which the run command already does.

---

## 3. Build the APK with EAS (recommended)

```bash
npm install -g eas-cli
eas login
eas init                     # links the project to your Expo account
```

```bash
# Internal testers: an installable .apk, not a store bundle
eas build -p android --profile preview

# Store / Play Console: an .aab
eas build -p android --profile production
```

The build runs in Expo's cloud, prints a download URL when it finishes, and
takes roughly 10–20 minutes on a free tier queue. When it completes:

```bash
# Install straight onto a connected device
eas build:run -p android --latest
```

or download the `.apk` from the URL and install it directly — Android will ask
for permission to install from an unknown source, which is expected for a
non-Play build.

### Profile reference

| Profile | Output | API target | Use for |
| --- | --- | --- | --- |
| `development` | APK + dev client | local | Native debugging, hot reload on device |
| `preview` | APK | `10.0.2.2:8000` | Emulator demos, internal QA |
| `production` | AAB | EAS secret | Play Store submission |
| `production-apk` | APK | EAS secret | Direct install in a hospital, sideloading |

---

## 4. Build the APK locally

Requires **JDK 17** (not 11 — Gradle refuses outright), the Android SDK with
platform 36, and `ANDROID_HOME` set.

```bash
cd mobile
npx expo prebuild --platform android --clean     # writes android/
cd android

# Debug APK — signed with the debug keystore, installable immediately
./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk

# Release APK — needs a keystore
./gradlew assembleRelease
```

Generate a release keystore once, and keep it somewhere you will still have it in
three years — losing it means you can never update the app on Play again:

```bash
keytool -genkeypair -v \
  -keystore medmesh-release.keystore \
  -alias medmesh \
  -keyalg RSA -keysize 2048 -validity 10000
```

Install onto a device:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

> The first `assembleDebug` is slow — it downloads several hundred megabytes of
> Gradle and Maven artifacts before it compiles anything. On a two-core machine
> budget half an hour and raise the heap in `gradle.properties` if it thrashes.
> Subsequent builds are incremental and take a couple of minutes.

> `android/` is generated. Do not hand-edit it: `prebuild --clean` overwrites it,
> and anything that must persist belongs in `app.config.ts`. This is why the Maps
> key and permissions live there rather than in `AndroidManifest.xml`. `android/`
> is in `.gitignore` for the same reason.

---

## 5. What the Android build actually contains

- **One app, role-scoped.** Dispatcher, ward, crew, government and citizen
  surfaces are all in this bundle; the signed-in role decides what the shell
  shows. There is no per-role APK.
- **Bottom tab bar on phones**, sidebar on tablets and desktop. Both are the same
  components — the `Shell` picks a layout from the measured width.
- **Permissions requested:** `INTERNET`, `ACCESS_FINE_LOCATION`,
  `ACCESS_COARSE_LOCATION`, `CALL_PHONE`. Location is used to show nearby
  facilities and route a crew to a scene; it is never attached to a patient
  record, because there is no patient record.
- **Background location is deliberately not requested.** A crew phone that tracks
  continuously is a battery and a privacy problem, and the app only needs a
  position when someone is looking at it.
- **Offline tolerance.** The crew screen keeps the last known assignment,
  destination and route on device (AsyncStorage) and shows a stale banner rather
  than a blank screen when the network drops. Capacity figures are timestamped
  everywhere for the same reason.

---

## 6. Verifying a build before you hand it over

Install the APK, sign in as each pilot role, and check the four things that are
easy to get wrong in a release build:

1. **API reachable.** Sign in as `dispatch@medmesh.in`. If the directory is empty
   and a banner says the API cannot be reached, `EXPO_PUBLIC_API_URL` was not set
   at build time. Web builds hide this because they use the same origin.
2. **Maps render.** Open the directory. With a key you get real tiles; without
   one you get the schematic canvas and a line telling you how to enable tiles.
   A grey rectangle means a key was set but is wrong or unrestricted for this
   package/SHA-1 pair.
3. **Navigation hands off.** On the crew screen, tap **Navigate**. It should open
   Google Maps (or Apple Maps on iOS) with the destination pre-filled. An
   in-app turn-by-turn that competes with the crew's own app would be worse.
4. **Phone layout.** Rotate nothing, open the inbox — the bottom bar must stay
   pinned and the page must not scroll horizontally.

The automated harness in `tools/qa/` covers 2 and 4 on the web build; the Android
checks are manual because they depend on device state.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SDK location not found` | `ANDROID_HOME` unset | `export ANDROID_HOME=$HOME/Android/Sdk` |
| `Gradle requires JVM 17 or later to run. Your build is currently configured to use JVM 11.` | An older JDK on `PATH` | Install JDK 17 and point `JAVA_HOME` at it |
| `FAILURE: Build failed ... Could not resolve all files` | No network to `dl.google.com` / Maven Central | First build downloads ~500 MB of artifacts |
| `Google Maps Android API v2 requires a key` in logcat | Key missing or package/SHA-1 mismatch | Re-check the restriction; debug and release keystores have different SHA-1s |
| Blank map, no tiles | Billing not enabled on the Google Cloud project | Maps SDK requires a billing account even inside the free tier |
| Network error on a physical device | `10.0.2.2` is emulator-only | Use the machine's LAN IP and bind the API to `0.0.0.0` |
| `InvalidKeyMapError` on web | Key restricted to the wrong origin | Add the exact origin (scheme + host + port) to the referrer list |
| Stale key in a web build | Metro cache retained the previous `EXPO_PUBLIC_*` value | Re-export with `--clear`; `mobile/setup.sh` always does |

---

## 8. Releasing to Play (if the district wants it)

```bash
eas build -p android --profile production     # .aab
eas submit -p android --latest                # to Play Console
```

Play requires: a signed AAB, a privacy policy URL, a data-safety declaration
(declare the location permission and that no health data is collected — MedMesh
holds aggregate counts only), and typically a closed test track before
production. The data-safety form is where the zero-PHI design pays off: there is
no patient data to declare because none is collected.
