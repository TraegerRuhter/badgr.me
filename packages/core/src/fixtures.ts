import type { Task } from "./types";

/**
 * Hardcoded sample data for the Phase 0 skeleton, shared by both clients so
 * the mobile app and the web PWA render the exact same list before sync
 * (Supabase) and local persistence (SQLite) exist yet.
 */
export const sampleTasks: Task[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Schedule Eye Appointment",
    notes: null,
    createdAt: "2026-06-16T09:00:00.000Z",
    updatedAt: "2026-06-16T09:00:00.000Z",
    fireAt: "2026-06-20T09:00:00.000Z",
    nagIntervalSeconds: 3600,
    nagMaxCount: 6,
    nagUntil: null,
    escalationMode: "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: null,
    priority: 1,
    deviceOrigin: "mobile",
    deletedAt: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Renew car registration",
    notes: "Due before end of month",
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    fireAt: "2026-06-21T08:00:00.000Z",
    nagIntervalSeconds: 120,
    nagMaxCount: null,
    nagUntil: "2026-06-21T12:00:00.000Z",
    escalationMode: "shrink",
    completedAt: null,
    dismissedAt: null,
    repeatRule: null,
    priority: 2,
    deviceOrigin: "web",
    deletedAt: null,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Take out recycling",
    notes: null,
    createdAt: "2026-06-19T20:00:00.000Z",
    updatedAt: "2026-06-19T20:00:00.000Z",
    fireAt: "2026-06-25T07:00:00.000Z",
    nagIntervalSeconds: 600,
    nagMaxCount: 3,
    nagUntil: null,
    escalationMode: "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: "FREQ=WEEKLY;BYDAY=TH",
    priority: 0,
    deviceOrigin: "mobile",
    deletedAt: null,
  },
];
