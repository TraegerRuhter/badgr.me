import { z } from "zod";

export const escalationModeSchema = z.enum(["none", "shrink", "sound"]);
export const deviceOriginSchema = z.enum(["mobile", "web"]);

export const taskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  fireAt: z.string().datetime(),
  nagIntervalSeconds: z.number().int().positive(),
  nagMaxCount: z.number().int().positive().nullable(),
  nagUntil: z.string().datetime().nullable(),
  escalationMode: escalationModeSchema,
  completedAt: z.string().datetime().nullable(),
  dismissedAt: z.string().datetime().nullable(),
  repeatRule: z.string().nullable(),
  priority: z.number().int(),
  deviceOrigin: deviceOriginSchema,
  deletedAt: z.string().datetime().nullable(),
});

export const newTaskSchema = taskSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const nagEventSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  scheduledFor: z.string().datetime(),
  fired: z.boolean(),
  acknowledged: z.boolean(),
});
