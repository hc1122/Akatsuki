# Building AKATSUKI APK on Ubuntu

## Prerequisites

### Step 1: Install JDK 17
```bash
sudo apt update
sudo apt install -y openjdk-17-jdk unzip wget
```

### Step 2: Install Android SDK Command Line Tools
```bash
mkdir -p ~/android-sdk/cmdline-tools
cd ~/android-sdk/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdline-tools.zip
unzip cmdline-tools.zip
mv cmdline-tools latest
rm cmdline-tools.zip
```

### Step 3: Set Environment Variables
Add these to `~/.bashrc`:
```bash
export ANDROID_HOME=~/android-sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools
```
Then run: `source ~/.bashrc`

### Step 4: Install Android SDK Packages
```bash
yes | sdkmanager --sdk_root=$ANDROID_HOME "platforms;android-34" "build-tools;34.0.0" "platform-tools"
yes | sdkmanager --sdk_root=$ANDROID_HOME --licenses
```

## Build the APK

### Step 5: Copy android-app folder to your server
Copy the entire `android-app/` directory to your Ubuntu server.

### Step 6: Create local.properties
```bash
cd ~/android-app
echo "sdk.dir=$HOME/android-sdk" > local.properties
```

### Step 7: Download Gradle Wrapper
```bash
cd ~/android-app
wget https://services.gradle.org/distributions/gradle-8.5-bin.zip -O /tmp/gradle.zip
unzip /tmp/gradle.zip -d /tmp/
/tmp/gradle-8.5/bin/gradle wrapper --gradle-version 8.5
rm -rf /tmp/gradle-8.5 /tmp/gradle.zip
```

### Step 8: Build Debug APK
```bash
chmod +x gradlew
./gradlew assembleDebug
```

### Step 9: Get your APK
The APK will be at:
```
app/build/outputs/apk/debug/app-debug.apk
```

Transfer it to your phone and install it. You may need to enable "Install from unknown sources" in Android settings.

## Build Release APK (Optional)

For a signed release APK:
```bash
# Generate a keystore (one time only)
keytool -genkey -v -keystore akatsuki.keystore -alias akatsuki -keyalg RSA -keysize 2048 -validity 10000

# Build release
./gradlew assembleRelease
```

## Notes
- The APK runs entirely on your phone - no server needed
- All Kotak API calls go directly from your phone
- Credentials are stored locally in Android SharedPreferences
- First login: enter your Kotak credentials (saved for future use)
- Each session: just enter your 6-digit TOTP
