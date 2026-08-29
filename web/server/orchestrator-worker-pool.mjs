import { fork } from "node:child_process";

export function createOrchestratorWorkerPool(options) {
  const workers = new Map();
  const taskOwners = new Map();
  let workerSequence = 0;
  let closing = false;

  function spawnWorker() {
    const id = `shared-${String(++workerSequence).padStart(2, "0")}`;
    const child = fork(options.workerFile, [], {
      cwd: options.cwd,
      env: { ...process.env, TAH_SHARED_WORKER_ID: id, TAH_SHARED_WORKER_SLOTS: String(options.slotsPerProcess) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const worker = { id, child, tasks: new Map(), stats: { browserInstances: 0, activeContexts: 0, launchingInstances: 0 }, ready: false };
    workers.set(id, worker);
    child.on("message", message => {
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") worker.ready = true;
      if (message.type === "pool_stats") worker.stats = { ...worker.stats, ...(message.stats || {}), activeTasks: Number(message.activeTasks ?? worker.tasks.size) };
      const runId = String(message.runId ?? "");
      const handlers = runId ? worker.tasks.get(runId) : undefined;
      if (message.type === "capture") handlers?.onCapture?.(message.capture);
      else if (message.type === "route_decision") handlers?.onRouteDecision?.(message.decision);
      else if (message.type === "exit" && handlers) {
        worker.tasks.delete(runId);
        taskOwners.delete(runId);
        handlers.onExit?.(Number(message.code ?? 99), message.error ? String(message.error) : undefined);
      }
    });
    child.stdout?.on("data", chunk => options.onWorkerLog?.(id, "stdout", chunk.toString("utf8")));
    child.stderr?.on("data", chunk => options.onWorkerLog?.(id, "stderr", chunk.toString("utf8")));
    child.on("exit", code => {
      workers.delete(id);
      for (const [runId, handlers] of worker.tasks) {
        taskOwners.delete(runId);
        handlers.onExit?.(Number(code ?? 99), `Shared worker ${id} exited unexpectedly`);
      }
      worker.tasks.clear();
    });
    return worker;
  }

  function selectWorker() {
    const available = [...workers.values()].filter(worker => worker.child.exitCode === null && worker.tasks.size < options.slotsPerProcess).sort((a, b) => a.tasks.size - b.tasks.size)[0];
    if (available) return available;
    if (workers.size < options.processCount) return spawnWorker();
    return null;
  }

  return {
    async start(job, handlers) {
      if (closing) throw new Error("Shared orchestrator pool is shutting down");
      if (taskOwners.has(job.runId)) throw new Error("Campaign task is already assigned to a shared worker");
      const worker = selectWorker();
      if (!worker) throw new Error(`Shared orchestrator capacity reached (${options.processCount * options.slotsPerProcess} tasks)`);
      worker.tasks.set(job.runId, handlers);
      taskOwners.set(job.runId, worker.id);
      await new Promise((resolve, reject) => worker.child.send({ type: "start", job }, error => error ? reject(error) : resolve()));
      return { workerId: worker.id, pid: worker.child.pid };
    },
    stop(runId) {
      const worker = workers.get(taskOwners.get(runId));
      if (!worker || worker.child.exitCode !== null) return false;
      worker.child.send({ type: "stop", runId });
      return true;
    },
    has(runId) { return taskOwners.has(runId); },
    capacity() { return options.processCount * options.slotsPerProcess; },
    snapshot() {
      const rows = [...workers.values()].map(worker => ({ id: worker.id, pid: worker.child.pid ?? null, activeTasks: worker.tasks.size, ready: worker.ready, ...worker.stats }));
      return {
        enabled: true,
        configuredProcesses: options.processCount,
        slotsPerProcess: options.slotsPerProcess,
        taskCapacity: options.processCount * options.slotsPerProcess,
        liveProcesses: rows.length,
        activeTasks: taskOwners.size,
        browserInstances: rows.reduce((sum, row) => sum + Number(row.browserInstances || 0), 0),
        activeBrowserContexts: rows.reduce((sum, row) => sum + Number(row.activeContexts || 0), 0),
        workers: rows,
      };
    },
    async shutdown() {
      closing = true;
      for (const worker of workers.values()) if (worker.child.exitCode === null) worker.child.send({ type: "shutdown" });
      await new Promise(resolve => setTimeout(resolve, 2_000));
      for (const worker of workers.values()) if (worker.child.exitCode === null) worker.child.kill();
    },
  };
}
