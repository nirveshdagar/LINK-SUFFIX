function cloneState(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function createSerializedStateWriter(saveState) {
  if (typeof saveState !== "function") throw new TypeError("saveState must be a function");
  let tail = Promise.resolve();

  return function queueStateSave(name, value) {
    const stateName = String(name ?? "").trim();
    if (!stateName) return Promise.reject(new Error("A state name is required"));
    if (arguments.length < 2) return Promise.reject(new Error(`State payload is required for ${stateName}`));
    const snapshot = cloneState(value);
    const task = tail.catch(() => undefined).then(() => saveState(stateName, snapshot));
    tail = task.catch(() => undefined);
    return task;
  };
}
