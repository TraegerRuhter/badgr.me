import { sampleTasks, type Task } from "@alarmed/core";
import { colors, spacing, typography } from "@alarmed/ui";
import { StatusBar } from "expo-status-bar";
import { FlatList, StyleSheet, Text, View } from "react-native";

function formatFireAt(task: Task) {
  return new Date(task.fireAt).toLocaleString();
}

function TaskRow({ task }: { task: Task }) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{task.title}</Text>
      <Text style={styles.caption}>
        Fires {formatFireAt(task)} · every {task.nagIntervalSeconds}s
      </Text>
    </View>
  );
}

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.header}>Alarmed</Text>
      <FlatList
        data={sampleTasks}
        keyExtractor={(task) => task.id}
        renderItem={({ item }) => <TaskRow task={item} />}
        contentContainerStyle={styles.list}
      />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: 60,
  },
  header: {
    ...typography.title,
    fontSize: 28,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    color: colors.textPrimary,
  },
  list: {
    paddingHorizontal: spacing.md,
  },
  row: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: {
    ...typography.body,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
});
