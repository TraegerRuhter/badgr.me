import { sampleTasks, type Task } from "@alarmed/core";
import "./App.css";

function formatFireAt(task: Task) {
  return new Date(task.fireAt).toLocaleString();
}

function TaskRow({ task }: { task: Task }) {
  return (
    <li className="task-row">
      <div className="task-title">{task.title}</div>
      <div className="task-caption">
        Fires {formatFireAt(task)} · every {task.nagIntervalSeconds}s
      </div>
    </li>
  );
}

export default function App() {
  return (
    <div className="app">
      <h1>Alarmed</h1>
      <ul className="task-list">
        {sampleTasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ul>
    </div>
  );
}
