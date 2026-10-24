/**
 * test_remembered_accounts_simulation.mjs
 * Comprehensive simulation test suite for Remembered Accounts,
 * Secure Session Persistence, and Seven-Day Inactivity Expiry.
 */

import assert from "node:assert";
import {
    REMEMBERED_ACCOUNTS_STORAGE_KEY,
    SEVEN_DAYS_MS,
    getRememberedAccountsRaw,
    getRememberedAccount,
    saveRememberedAccount,
    renewRememberedAccountActivity,
    forgetRememberedAccount,
    cleanupExpiredRememberedAccounts
} from "../../www/js/shared/remembered-accounts.js";

// Mock localStorage for Node.js environment
const storageBackend = new Map();
global.localStorage = {
    getItem(k) { return storageBackend.get(k) || null; },
    setItem(k, v) { storageBackend.set(k, String(v)); },
    removeItem(k) { storageBackend.delete(k); },
    clear() { storageBackend.clear(); }
};

// Mock translations
const mockTranslations = {
    en: {
        "auth.btn_continue_mobile": "Continue with mobile number",
        "auth.btn_driver_signup": "Captain / Driver Signup",
        "auth.continue_as": "Continue as {name}",
        "auth.switch_account": "Switch account",
        "auth.welcome_back_user": "Welcome back, {name}! Enter your password to continue."
    },
    bn: {
        "auth.btn_continue_mobile": "মোবাইল নম্বর দিয়ে এগিয়ে যান",
        "auth.btn_driver_signup": "ক্যাপ্টেন / ড্রাইভার সাইন আপ",
        "auth.continue_as": "{name} হিসেবে চালিয়ে যান",
        "auth.switch_account": "অ্যাকাউন্ট পরিবর্তন করুন",
        "auth.welcome_back_user": "স্বাগতম, {name}! চালিয়ে যেতে আপনার পাসওয়ার্ড লিখুন।"
    }
};

function renderWelcomeScreen(lang = "en", nowMs = Date.now()) {
    const dict = mockTranslations[lang] || mockTranslations.en;
    cleanupExpiredRememberedAccounts(nowMs);

    const passenger = getRememberedAccount("passenger", nowMs);
    const driver = getRememberedAccount("driver", nowMs);

    const passengerLabel = passenger && passenger.name
        ? dict["auth.continue_as"].replace("{name}", passenger.name)
        : dict["auth.btn_continue_mobile"];

    const driverLabel = driver && driver.name
        ? dict["auth.continue_as"].replace("{name}", driver.name)
        : dict["auth.btn_driver_signup"];

    return {
        passengerLabel,
        driverLabel,
        hasPassengerSwitch: Boolean(passenger && passenger.name),
        hasDriverSwitch: Boolean(driver && driver.name),
        passengerAccount: passenger,
        driverAccount: driver
    };
}

console.log("=== STARTING REMEMBERED ACCOUNTS SIMULATION TESTS ===");

// ---------------------------------------------------------------------------
// TEST 1: Initial State - No remembered accounts
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 1] Testing initial state with no remembered accounts...");
    localStorage.clear();

    const initial = getRememberedAccountsRaw();
    assert.strictEqual(initial.passenger, null, "Passenger should be null initially");
    assert.strictEqual(initial.driver, null, "Driver should be null initially");

    const ui = renderWelcomeScreen("en");
    assert.strictEqual(ui.passengerLabel, "Continue with mobile number");
    assert.strictEqual(ui.driverLabel, "Captain / Driver Signup");
    assert.strictEqual(ui.hasPassengerSwitch, false);
    assert.strictEqual(ui.hasDriverSwitch, false);

    console.log("✔ PASS: Clean initial state renders default labels and hides switch links.");
}

// ---------------------------------------------------------------------------
// TEST 2: Passenger-Only Remembered Account
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 2] Testing Passenger-only remembered account...");
    localStorage.clear();
    const t0 = 1700000000000;

    saveRememberedAccount({
        uid: "user_pass_123",
        name: "Rahul Debbarma",
        phone: "+919876543210",
        role: "passenger"
    }, t0);

    const passenger = getRememberedAccount("passenger", t0);
    const driver = getRememberedAccount("driver", t0);

    assert.ok(passenger, "Passenger account must exist");
    assert.strictEqual(passenger.name, "Rahul Debbarma");
    assert.strictEqual(passenger.role, "passenger");
    assert.strictEqual(driver, null, "Driver account must remain null");

    const uiEn = renderWelcomeScreen("en", t0);
    assert.strictEqual(uiEn.passengerLabel, "Continue as Rahul Debbarma");
    assert.strictEqual(uiEn.driverLabel, "Captain / Driver Signup");
    assert.strictEqual(uiEn.hasPassengerSwitch, true);
    assert.strictEqual(uiEn.hasDriverSwitch, false);

    // Test Bengali localization
    const uiBn = renderWelcomeScreen("bn", t0);
    assert.strictEqual(uiBn.passengerLabel, "Rahul Debbarma হিসেবে চালিয়ে যান");
    assert.strictEqual(uiBn.driverLabel, "ক্যাপ্টেন / ড্রাইভার সাইন আপ");

    console.log("✔ PASS: Passenger-only state updates passenger button and preserves driver button.");
}

// ---------------------------------------------------------------------------
// TEST 3: Driver-Only Remembered Account
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 3] Testing Driver-only remembered account...");
    localStorage.clear();
    const t0 = 1700000000000;

    saveRememberedAccount({
        uid: "user_driver_456",
        name: "Bikash Sarkar",
        phone: "+919876543211",
        role: "driver"
    }, t0);

    const passenger = getRememberedAccount("passenger", t0);
    const driver = getRememberedAccount("driver", t0);

    assert.strictEqual(passenger, null, "Passenger account must remain null");
    assert.ok(driver, "Driver account must exist");
    assert.strictEqual(driver.name, "Bikash Sarkar");
    assert.strictEqual(driver.role, "driver");

    const ui = renderWelcomeScreen("en", t0);
    assert.strictEqual(ui.passengerLabel, "Continue with mobile number");
    assert.strictEqual(ui.driverLabel, "Continue as Bikash Sarkar");
    assert.strictEqual(ui.hasPassengerSwitch, false);
    assert.strictEqual(ui.hasDriverSwitch, true);

    console.log("✔ PASS: Driver-only state updates driver button and preserves passenger button.");
}

// ---------------------------------------------------------------------------
// TEST 4: Dual Accounts (Both Passenger and Driver Remembered)
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 4] Testing Dual Accounts (Passenger + Driver)...");
    localStorage.clear();
    const t0 = 1700000000000;

    saveRememberedAccount({
        uid: "pass_user_1",
        name: "Anjali Roy",
        phone: "+919123456789",
        role: "passenger"
    }, t0);

    saveRememberedAccount({
        uid: "driver_user_2",
        name: "Subrata Nath",
        phone: "+919876501234",
        role: "driver"
    }, t0 + 1000);

    const ui = renderWelcomeScreen("en", t0 + 1000);
    assert.strictEqual(ui.passengerLabel, "Continue as Anjali Roy");
    assert.strictEqual(ui.driverLabel, "Continue as Subrata Nath");
    assert.strictEqual(ui.hasPassengerSwitch, true);
    assert.strictEqual(ui.hasDriverSwitch, true);

    // Verify isolation: Passenger data does not corrupt Driver data
    assert.strictEqual(ui.passengerAccount.phone, "+919123456789");
    assert.strictEqual(ui.driverAccount.phone, "+919876501234");
    assert.notStrictEqual(ui.passengerAccount.uid, ui.driverAccount.uid);

    console.log("✔ PASS: Both accounts co-exist independently with complete data isolation.");
}

// ---------------------------------------------------------------------------
// TEST 5: Logout Memory Preservation & Non-Sensitive Storage Guarantee
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 5] Testing Logout Memory Preservation & Non-Sensitive Security...");
    localStorage.clear();
    const t0 = 1700000000000;

    saveRememberedAccount({
        uid: "pass_user_sec",
        name: "Pooja Das",
        phone: "+919000000001",
        role: "passenger",
        // Malicious or sensitive properties that should NEVER be stored
        password: "super_secret_password",
        token: "firebase_jwt_token_123",
        otp: "123456"
    }, t0);

    const raw = JSON.parse(localStorage.getItem(REMEMBERED_ACCOUNTS_STORAGE_KEY));
    const passMeta = raw.passenger;

    // Security assertions
    assert.strictEqual(passMeta.password, undefined, "Password must never be saved");
    assert.strictEqual(passMeta.token, undefined, "Token must never be saved");
    assert.strictEqual(passMeta.otp, undefined, "OTP must never be saved");
    assert.strictEqual(passMeta.name, "Pooja Das");
    assert.strictEqual(passMeta.phone, "+919000000001");

    // Simulate Logout: session caches are cleared, but remembered metadata remains intact
    localStorage.removeItem("liphtup_user_profile");
    sessionStorageBackendClear: {
        // Simulating sessionStorage.removeItem("liphtup_user_profile")
    }

    const postLogoutAccount = getRememberedAccount("passenger", t0 + 1000);
    assert.ok(postLogoutAccount, "Remembered passenger account MUST survive logout");
    assert.strictEqual(postLogoutAccount.name, "Pooja Das");

    const ui = renderWelcomeScreen("en", t0 + 1000);
    assert.strictEqual(ui.passengerLabel, "Continue as Pooja Das");

    console.log("✔ PASS: Logout preserves non-sensitive identity metadata; passwords & tokens are never stored.");
}

// ---------------------------------------------------------------------------
// TEST 6: Strict Seven-Day Inactivity Expiration
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 6] Testing Seven-Day Inactivity Expiration...");
    localStorage.clear();
    const t0 = 1700000000000; // Day 0

    saveRememberedAccount({
        uid: "user_p_expire",
        name: "Suman Barman",
        phone: "+919000000002",
        role: "passenger"
    }, t0);

    // Active at Day 6 (518,400,000 ms)
    const day6 = t0 + (6 * 24 * 3600 * 1000);
    const accDay6 = getRememberedAccount("passenger", day6);
    assert.ok(accDay6, "Account must be valid on Day 6 (< 7 days)");
    assert.strictEqual(accDay6.name, "Suman Barman");

    // Exactly 7 days (604,800,000 ms)
    const day7Exact = t0 + SEVEN_DAYS_MS;
    const accDay7 = getRememberedAccount("passenger", day7Exact);
    assert.ok(accDay7, "Account should be valid at exact 7-day boundary");

    // Expired at 7 days + 1 millisecond
    const day7Plus = t0 + SEVEN_DAYS_MS + 1;
    const accExpired = getRememberedAccount("passenger", day7Plus);
    assert.strictEqual(accExpired, null, "Account MUST expire and return null at 7 days + 1 ms");

    // Storage must be cleanly purged
    const store = getRememberedAccountsRaw();
    assert.strictEqual(store.passenger, null, "Expired account must be purged from storage");

    // UI reverts to default
    const ui = renderWelcomeScreen("en", day7Plus);
    assert.strictEqual(ui.passengerLabel, "Continue with mobile number");

    console.log("✔ PASS: Strict 7-day inactivity rule automatically purges expired entry and reverts button.");
}

// ---------------------------------------------------------------------------
// TEST 7: Independent Expiration for Dual Accounts
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 7] Testing Independent Expiration in Dual Account Setup...");
    localStorage.clear();
    const t0 = 1700000000000;

    // Passenger last active at t0
    saveRememberedAccount({
        uid: "pass_older",
        name: "Older Passenger",
        phone: "+919000000010",
        role: "passenger"
    }, t0);

    // Driver active 4 days later (t0 + 4 days)
    const tDriver = t0 + (4 * 24 * 3600 * 1000);
    saveRememberedAccount({
        uid: "driver_newer",
        name: "Newer Driver",
        phone: "+919000000020",
        role: "driver"
    }, tDriver);

    // Check at t0 + 7.5 days:
    // Passenger is 7.5 days old -> EXPIRED
    // Driver is 3.5 days old -> STILL ACTIVE
    const tCheck = t0 + (7.5 * 24 * 3600 * 1000);
    const passCheck = getRememberedAccount("passenger", tCheck);
    const driverCheck = getRememberedAccount("driver", tCheck);

    assert.strictEqual(passCheck, null, "Older passenger account must be expired");
    assert.ok(driverCheck, "Newer driver account must remain active");
    assert.strictEqual(driverCheck.name, "Newer Driver");

    const store = getRememberedAccountsRaw();
    assert.strictEqual(store.passenger, null);
    assert.ok(store.driver);

    console.log("✔ PASS: Passenger and Driver accounts expire independently based on individual activity.");
}

// ---------------------------------------------------------------------------
// TEST 8: Activity Renewal Advances the Expiry Deadline
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 8] Testing Activity Renewal (advancing 7-day inactivity deadline)...");
    localStorage.clear();
    const t0 = 1700000000000;

    saveRememberedAccount({
        uid: "renew_user",
        name: "Active Rider",
        phone: "+919000000030",
        role: "passenger"
    }, t0);

    const initial = getRememberedAccount("passenger", t0);
    assert.strictEqual(initial.expiresAt, t0 + SEVEN_DAYS_MS);

    // Meaningful activity happens at Day 5
    const day5 = t0 + (5 * 24 * 3600 * 1000);
    renewRememberedAccountActivity("passenger", day5);

    const renewed = getRememberedAccount("passenger", day5);
    assert.strictEqual(renewed.lastMeaningfulActivityAt, day5);
    assert.strictEqual(renewed.expiresAt, day5 + SEVEN_DAYS_MS, "Expiry must advance to Day 5 + 7 days");

    // At Day 8 (which would have expired under initial deadline t0 + 7 days):
    const day8 = t0 + (8 * 24 * 3600 * 1000);
    const activeAtDay8 = getRememberedAccount("passenger", day8);
    assert.ok(activeAtDay8, "Must remain active on Day 8 due to Day 5 renewal");
    assert.strictEqual(activeAtDay8.name, "Active Rider");

    console.log("✔ PASS: Meaningful activity resets the 7-day inactivity clock forward.");
}

// ---------------------------------------------------------------------------
// TEST 9: Account Switching ("Forget this account")
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 9] Testing Account Switching ('Forget this account')...");
    localStorage.clear();
    const t0 = 1700000000000;

    saveRememberedAccount({ uid: "p1", name: "User P", phone: "+919000000041", role: "passenger" }, t0);
    saveRememberedAccount({ uid: "d1", name: "Captain D", phone: "+919000000042", role: "driver" }, t0);

    // Switch passenger account
    forgetRememberedAccount("passenger");

    assert.strictEqual(getRememberedAccount("passenger", t0), null, "Passenger account must be forgotten");
    const driverStill = getRememberedAccount("driver", t0);
    assert.ok(driverStill, "Driver account must NOT be affected by passenger forget");
    assert.strictEqual(driverStill.name, "Captain D");

    const ui = renderWelcomeScreen("en", t0);
    assert.strictEqual(ui.passengerLabel, "Continue with mobile number");
    assert.strictEqual(ui.driverLabel, "Continue as Captain D");
    assert.strictEqual(ui.hasPassengerSwitch, false);
    assert.strictEqual(ui.hasDriverSwitch, true);

    // Switch driver account
    forgetRememberedAccount("driver");
    assert.strictEqual(getRememberedAccount("driver", t0), null, "Driver account must be forgotten");

    const uiAllForgotten = renderWelcomeScreen("en", t0);
    assert.strictEqual(uiAllForgotten.passengerLabel, "Continue with mobile number");
    assert.strictEqual(uiAllForgotten.driverLabel, "Captain / Driver Signup");
    assert.strictEqual(uiAllForgotten.hasPassengerSwitch, false);
    assert.strictEqual(uiAllForgotten.hasDriverSwitch, false);

    console.log("✔ PASS: Explicit forget cleans up role-specifically without affecting other roles.");
}

// ---------------------------------------------------------------------------
// TEST 10: Capacitor Android Native Bridge Fallback (localStorage wipe survival)
// ---------------------------------------------------------------------------
{
    console.log("\n[Test 10] Testing Capacitor Android Native Bridge Fallback (localStorage wipe survival)...");
    localStorage.clear();
    const t0 = 1700000000000;

    let nativeStoreJson = "";
    global.window = {
        LiphtUpNativeStatus: {
            setRememberedAccounts(json) { nativeStoreJson = json; },
            getRememberedAccounts() { return nativeStoreJson; }
        }
    };

    saveRememberedAccount({
        uid: "android_user_1",
        name: "Debashis Roy",
        phone: "+919988776655",
        role: "passenger"
    }, t0);

    // Verify written to native storage bridge
    assert.ok(nativeStoreJson.includes("Debashis Roy"), "Native bridge must receive remembered account JSON");

    // Simulate complete Android WebView localStorage wipe (e.g. OS clear data or cache reset)
    localStorage.clear();
    assert.strictEqual(localStorage.getItem(REMEMBERED_ACCOUNTS_STORAGE_KEY), null);

    // Read account: should automatically recover from native bridge SharedPreferences
    const recovered = getRememberedAccount("passenger", t0);
    assert.ok(recovered, "Must recover account from Android Native SharedPreferences");
    assert.strictEqual(recovered.name, "Debashis Roy");
    assert.strictEqual(recovered.phone, "+919988776655");

    // Verify localStorage was re-hydrated
    assert.ok(localStorage.getItem(REMEMBERED_ACCOUNTS_STORAGE_KEY), "localStorage must be re-hydrated from native bridge");

    delete global.window;
    console.log("✔ PASS: Capacitor Android native bridge safely recovers remembered accounts if WebView storage is cleared.");
}

console.log("\n========================================================");
console.log("🎉 ALL 10 SIMULATION TEST SUITES PASSED FLAWLESSLY!");
console.log("========================================================\n");
