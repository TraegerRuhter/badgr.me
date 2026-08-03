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
  clearDeviceVault,
  createDeviceVault,
  isVaultConfigured,
} from "../crypto/keystore";
import {
  exportToShareSheet,
  importFromDocumentPicker,
  joinVaultFromFile,
} from "../sync/portableFile";

/**
 * Encrypted snapshot export/import (build plan §8, Phase 3).
 *
 * Deliberately its own component rather than more rows in the settings sheet:
 * it owns a security surface — the rollback warning — that must not read as
 * just another toast, and it holds a passphrase in state that should unmount
 * with the panel rather than live in the app's long-lived settings tree.
 */

type Busy = "none" | "creating" | "exporting" | "importing" | "joining";

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

  const onForget = () =>
    run("creating", async () => {
      await clearDeviceVault();
      setConfigured(false);
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
          <View style={styles.row}>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.btnAccent,
                passphrase.length === 0 && styles.btnOff,
                pressed && styles.pressed,
              ]}
              disabled={working || passphrase.length === 0}
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
