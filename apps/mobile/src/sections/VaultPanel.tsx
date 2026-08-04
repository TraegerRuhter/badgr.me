import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { colors, radii, spacing, typography } from "@alarmed/ui";
import { isRollbackRejection } from "@alarmed/portable-sync";

import { Icon } from "../ui/Icon";
import {
  changeDevicePassphrase,
  clearDeviceVault,
  createDeviceVault,
  isVaultConfigured,
  showRecoveryCode,
} from "../crypto/keystore";
import {
  exportToShareSheet,
  importFromDocumentPicker,
  joinVaultFromFile,
  recoverVaultFromFile,
} from "../sync/portableFile";

/**
 * Encrypted snapshot export/import (build plan §8, Phase 3).
 *
 * Deliberately its own component rather than more rows in the settings sheet:
 * it owns a security surface — the rollback warning — that must not read as
 * just another toast, and it holds a passphrase in state that should unmount
 * with the panel rather than live in the app's long-lived settings tree.
 */

type Busy =
  | "none"
  | "creating"
  | "exporting"
  | "importing"
  | "joining"
  | "recovering"
  | "revealing"
  | "rotating";

type Sheet = "none" | "recovery" | "rotate" | "restore";

export function VaultPanel() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState<Busy>("none");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Kept apart from `error` on purpose. A rollback rejection is a security
   * event (§4.3), and folding it into the same line as "couldn't read that
   * file" would let the one message that must never be missed look routine.
   */
  const [securityAlert, setSecurityAlert] = useState<string | null>(null);

  /** Only one secondary flow open at a time, so the panel stays readable. */
  const [sheet, setSheet] = useState<Sheet>("none");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [newPassphrase, setNewPassphrase] = useState("");
  /**
   * Creating a vault is gated on this (plan §7). A checkbox is a low bar, but
   * it is the difference between "nobody told me" and "I was told" — and there
   * is genuinely no recovery to offer afterwards.
   */
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isVaultConfigured().then((ok) => {
      if (!cancelled) setConfigured(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (kind: Exclude<Busy, "none">, action: () => Promise<string | null>) => {
      setBusy(kind);
      setStatus(null);
      setError(null);
      try {
        const message = await action();
        if (message !== null) setStatus(message);
      } catch (err) {
        if (isRollbackRejection(err)) {
          setSecurityAlert(err.message);
        } else {
          setError(err instanceof Error ? err.message : "Something went wrong");
        }
      } finally {
        setBusy("none");
      }
    },
    []
  );

  const onCreate = () =>
    run("creating", async () => {
      await createDeviceVault(passphrase);
      setPassphrase("");
      setConfigured(true);
      return "Vault created. Export a snapshot to set up your other device.";
    });

  const onJoin = () =>
    run("joining", async () => {
      const result = await joinVaultFromFile(passphrase);
      if (result.status === "cancelled") return null;
      setPassphrase("");
      setConfigured(true);
      return `Joined the vault and merged ${result.applied} task${result.applied === 1 ? "" : "s"}.`;
    });

  const onExport = () =>
    run("exporting", async () => {
      const result = await exportToShareSheet();
      return result.shared
        ? `Sealed ${result.taskCount} task${result.taskCount === 1 ? "" : "s"} at sequence ${result.seq}.`
        : `Sharing isn't available here — the snapshot is saved at ${result.uri}.`;
    });

  const onImport = () =>
    run("importing", async () => {
      const result = await importFromDocumentPicker();
      if (result.status === "cancelled") return null;
      const ahead =
        result.localAhead > 0
          ? ` ${result.localAhead} task${result.localAhead === 1 ? "" : "s"} here ${result.localAhead === 1 ? "is" : "are"} newer — export to send ${result.localAhead === 1 ? "it" : "them"} back.`
          : "";
      return `Merged ${result.applied} task${result.applied === 1 ? "" : "s"}.${ahead}`;
    });

  const onReveal = () =>
    run("revealing", async () => {
      setRecoveryCode(await showRecoveryCode(passphrase));
      setPassphrase("");
      return null;
    });

  const onRotate = () =>
    run("rotating", async () => {
      await changeDevicePassphrase(passphrase, newPassphrase);
      setPassphrase("");
      setNewPassphrase("");
      setSheet("none");
      return "Passphrase changed. Export a fresh snapshot so your other devices get the new one — older files still need the old passphrase.";
    });

  const onRestore = () =>
    run("recovering", async () => {
      const result = await recoverVaultFromFile(passphrase);
      if (result.status === "cancelled") return null;
      setPassphrase("");
      setSheet("none");
      setConfigured(true);
      return `Recovered the vault and merged ${result.applied} task${result.applied === 1 ? "" : "s"}.`;
    });

  const closeSheet = () => {
    setSheet("none");
    setRecoveryCode(null);
    setPassphrase("");
    setNewPassphrase("");
  };

  const onForget = () =>
    run("creating", async () => {
      await clearDeviceVault();
      setConfigured(false);
      setSheet("none");
      setRecoveryCode(null);
      return "Vault forgotten on this device. Your tasks are untouched.";
    });

  const working = busy !== "none";

  return (
    <View style={styles.panel}>
      {securityAlert !== null && (
        <View style={styles.alert}>
          <View style={styles.alertHead}>
            <Icon name="warning" size={16} color={colors.danger} />
            <Text style={styles.alertTitle}>Rolled-back data refused</Text>
          </View>
          <Text style={styles.alertBody}>{securityAlert}</Text>
          <Pressable
            style={({ pressed }) => [styles.alertBtn, pressed && styles.pressed]}
            onPress={() => setSecurityAlert(null)}
          >
            <Text style={styles.alertBtnText}>I understand</Text>
          </Pressable>
        </View>
      )}

      {configured === null ? (
        <ActivityIndicator color={colors.accent} />
      ) : configured ? (
        <>
          <Text style={styles.desc}>
            Snapshots are encrypted on this device. Anyone who intercepts one sees only
            ciphertext — but they can't be recovered without your passphrase either.
          </Text>
          <View style={styles.row}>
            <Pressable
              style={({ pressed }) => [styles.btn, styles.btnAccent, pressed && styles.pressed]}
              disabled={working}
              onPress={onExport}
            >
              <Icon name="share" size={15} color={colors.onAccent} />
              <Text style={[styles.btnText, styles.btnTextAccent]}>
                {busy === "exporting" ? "Sealing…" : "Export"}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
              disabled={working}
              onPress={onImport}
            >
              <Icon name="inbox" size={15} color={colors.textPrimary} />
              <Text style={styles.btnText}>
                {busy === "importing" ? "Merging…" : "Import"}
              </Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
              disabled={working}
              onPress={() => {
                setSheet(sheet === "recovery" ? "none" : "recovery");
                setRecoveryCode(null);
              }}
            >
              <Icon name="lock" size={15} color={colors.textPrimary} />
              <Text style={styles.btnText}>Recovery sheet</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
              disabled={working}
              onPress={() => setSheet(sheet === "rotate" ? "none" : "rotate")}
            >
              <Icon name="repeat" size={15} color={colors.textPrimary} />
              <Text style={styles.btnText}>Passphrase</Text>
            </Pressable>
          </View>

          {sheet === "recovery" ? (
            <View style={styles.sub}>
              {recoveryCode === null ? (
                <>
                  <Text style={styles.desc}>
                    Your recovery sheet is the only way back in if you forget your
                    passphrase. Seeing it costs an unlock, so a phone left open on a table
                    can't give it away.
                  </Text>
                  <TextInput
                    style={styles.input}
                    value={passphrase}
                    onChangeText={setPassphrase}
                    placeholder="Current passphrase"
                    placeholderTextColor={colors.textSecondary}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <View style={styles.row}>
                    <Pressable
                      style={({ pressed }) => [
                        styles.btn,
                        styles.btnAccent,
                        passphrase.length === 0 && styles.btnOff,
                        pressed && styles.pressed,
                      ]}
                      disabled={working || passphrase.length === 0}
                      onPress={onReveal}
                    >
                      <Text style={[styles.btnText, styles.btnTextAccent]}>
                        {busy === "revealing" ? "Unlocking…" : "Show my code"}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
                      onPress={closeSheet}
                    >
                      <Text style={styles.btnText}>Cancel</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.code} selectable>
                    {recoveryCode}
                  </Text>
                  <Text style={styles.desc}>
                    Write this on paper and keep it with your important documents. It
                    stays valid even after you change your passphrase. Anyone holding both
                    this and one of your snapshot files can read your tasks.
                  </Text>
                  <Pressable
                    style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
                    onPress={closeSheet}
                  >
                    <Text style={styles.btnText}>Done</Text>
                  </Pressable>
                </>
              )}
            </View>
          ) : null}

          {sheet === "rotate" ? (
            <View style={styles.sub}>
              <Text style={styles.desc}>
                Changing your passphrase re-wraps the key — your tasks aren't re-encrypted
                and your recovery sheet stays valid.
              </Text>
              <TextInput
                style={styles.input}
                value={passphrase}
                onChangeText={setPassphrase}
                placeholder="Current passphrase"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={styles.input}
                value={newPassphrase}
                onChangeText={setNewPassphrase}
                placeholder="New passphrase"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.row}>
                <Pressable
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnAccent,
                    (passphrase.length === 0 || newPassphrase.length === 0) && styles.btnOff,
                    pressed && styles.pressed,
                  ]}
                  disabled={working || passphrase.length === 0 || newPassphrase.length === 0}
                  onPress={onRotate}
                >
                  <Text style={[styles.btnText, styles.btnTextAccent]}>
                    {busy === "rotating" ? "Re-wrapping…" : "Change it"}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
                  onPress={closeSheet}
                >
                  <Text style={styles.btnText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [styles.forgetBtn, pressed && styles.pressed]}
            disabled={working}
            onPress={onForget}
          >
            <Text style={styles.forgetText}>Forget vault on this device</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.desc}>
            Pick a passphrase to encrypt your snapshots. It never leaves this device and
            it cannot be reset — <Text style={styles.emphasis}>if you forget it, the
            snapshots are gone for good.</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder="Vault passphrase"
            placeholderTextColor={colors.textSecondary}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={styles.ack}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: acknowledged }}
            onPress={() => setAcknowledged((on) => !on)}
          >
            <View style={[styles.ackBox, acknowledged && styles.ackBoxOn]}>
              {acknowledged ? <Icon name="check" size={12} color={colors.onAccent} /> : null}
            </View>
            <Text style={styles.ackText}>
              I understand that if I forget this passphrase and lose my recovery sheet, my
              snapshots cannot be recovered by anyone.
            </Text>
          </Pressable>
          <View style={styles.row}>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.btnAccent,
                (passphrase.length === 0 || !acknowledged) && styles.btnOff,
                pressed && styles.pressed,
              ]}
              disabled={working || passphrase.length === 0 || !acknowledged}
              onPress={onCreate}
            >
              <Icon name="lock" size={15} color={colors.onAccent} />
              <Text style={[styles.btnText, styles.btnTextAccent]}>
                {busy === "creating" ? "Deriving…" : "Create vault"}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                passphrase.length === 0 && styles.btnOff,
                pressed && styles.pressed,
              ]}
              disabled={working || passphrase.length === 0}
              onPress={onJoin}
            >
              <Icon name="inbox" size={15} color={colors.textPrimary} />
              <Text style={styles.btnText}>
                {busy === "joining" ? "Unlocking…" : "Join existing"}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            Creating a vault takes a second or two — that slowness is the point, it's
            what makes guessing the passphrase expensive.
          </Text>

          <Pressable
            style={({ pressed }) => [styles.forgetBtn, pressed && styles.pressed]}
            disabled={working}
            onPress={() => setSheet(sheet === "restore" ? "none" : "restore")}
          >
            <Text style={styles.recoverLink}>
              Forgotten your passphrase? Recover with your sheet
            </Text>
          </Pressable>

          {sheet === "restore" ? (
            <View style={styles.sub}>
              <Text style={styles.desc}>
                Type the code from your recovery sheet, then pick any snapshot file from
                the vault. Case and dashes don't matter.
              </Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                value={passphrase}
                onChangeText={setPassphrase}
                placeholder="XXXX-XXXX-XXXX-…"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
              />
              <View style={styles.row}>
                <Pressable
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnAccent,
                    passphrase.length === 0 && styles.btnOff,
                    pressed && styles.pressed,
                  ]}
                  disabled={working || passphrase.length === 0}
                  onPress={onRestore}
                >
                  <Icon name="inbox" size={15} color={colors.onAccent} />
                  <Text style={[styles.btnText, styles.btnTextAccent]}>
                    {busy === "recovering" ? "Recovering…" : "Pick a snapshot"}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
                  onPress={closeSheet}
                >
                  <Text style={styles.btnText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </>
      )}

      {status !== null && <Text style={styles.status}>{status}</Text>}
      {error !== null && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  desc: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  emphasis: {
    color: colors.textPrimary,
    fontWeight: "700",
  },
  hint: {
    ...typography.caption,
    color: colors.textSecondary,
    fontStyle: "italic",
  },
  input: {
    ...typography.body,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
  },
  row: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  btnAccent: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  btnOff: {
    opacity: 0.45,
  },
  btnText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: "700",
  },
  btnTextAccent: {
    color: colors.onAccent,
  },
  pressed: {
    opacity: 0.7,
  },
  forgetBtn: {
    alignSelf: "flex-start",
    paddingVertical: spacing.xs,
  },
  forgetText: {
    ...typography.caption,
    color: colors.danger,
  },
  sub: {
    gap: 9,
    marginTop: 4,
    padding: 13,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceRaised,
  },
  /*
   * The code itself. Monospace and loosely spaced because it gets copied onto
   * paper by hand — the reader has to keep their place across 56 characters.
   */
  code: {
    fontFamily: "Courier",
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 28,
    letterSpacing: 0.6,
    color: colors.textPrimary,
    backgroundColor: colors.background,
    borderWidth: 2,
    borderColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  codeInput: {
    fontFamily: "Courier",
    letterSpacing: 0.5,
  },
  /* The no-recovery acknowledgement. Not styled to be skimmed past. */
  ack: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    padding: 11,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radii.sm,
    backgroundColor: colors.dangerSoft,
  },
  ackBox: {
    width: 18,
    height: 18,
    marginTop: 1,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  ackBoxOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  ackText: {
    ...typography.caption,
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.textPrimary,
  },
  recoverLink: {
    ...typography.caption,
    color: colors.textSecondary,
    textDecorationLine: "underline",
  },
  status: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  error: {
    ...typography.caption,
    color: colors.danger,
  },
  alert: {
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: 6,
  },
  alertHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  alertTitle: {
    ...typography.caption,
    color: colors.danger,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  alertBody: {
    ...typography.caption,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  alertBtn: {
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  alertBtnText: {
    ...typography.caption,
    color: colors.danger,
    fontWeight: "700",
  },
});
