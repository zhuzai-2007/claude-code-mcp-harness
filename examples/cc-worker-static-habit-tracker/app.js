/* -- State -- */

let habits = [];

function loadHabits() {
  try {
    const raw = localStorage.getItem("habits");
    habits = raw ? JSON.parse(raw) : [];
  } catch {
    habits = [];
  }
}

function saveHabits() {
  localStorage.setItem("habits", JSON.stringify(habits));
}

/* -- Helpers -- */

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function computeStreak(dates) {
  if (dates.length === 0) return 0;
  const sorted = [...new Set(dates)].sort().reverse();
  let streak = 0;
  const today = todayKey();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Streak can start from today or yesterday
  let expected = today;
  if (sorted[0] !== today && sorted[0] !== yesterday) return 0;
  if (sorted[0] === yesterday) expected = yesterday;

  for (const d of sorted) {
    if (d === expected) {
      streak++;
      const prev = new Date(expected);
      prev.setDate(prev.getDate() - 1);
      expected = prev.toISOString().slice(0, 10);
    } else {
      break;
    }
  }
  return streak;
}

/* -- Render -- */

function render() {
  const list = document.getElementById("habit-list");
  list.innerHTML = "";

  if (habits.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-msg";
    li.textContent = "No habits yet. Add one above!";
    list.appendChild(li);
    return;
  }

  const today = todayKey();

  habits.forEach((habit, index) => {
    const li = document.createElement("li");
    li.className = "habit-item";

    const nameSpan = document.createElement("span");
    nameSpan.className = "habit-name";
    nameSpan.textContent = habit.name;

    const streakSpan = document.createElement("span");
    streakSpan.className = "habit-streak";
    const streak = computeStreak(habit.dates);
    streakSpan.textContent = streak === 1 ? "1 day" : streak + " days";

    const btn = document.createElement("button");
    btn.className = "habit-btn";
    const doneToday = habit.dates.includes(today);
    if (doneToday) {
      btn.classList.add("done");
      btn.textContent = "Done [X]";
    } else {
      btn.textContent = "Done?";
      btn.addEventListener("click", () => {
        habit.dates.push(today);
        saveHabits();
        render();
      });
    }

    li.appendChild(nameSpan);
    li.appendChild(streakSpan);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

/* -- Init -- */

document.addEventListener("DOMContentLoaded", () => {
  loadHabits();
  render();

  document.getElementById("habit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("habit-input");
    const name = input.value.trim();
    if (!name) return;

    habits.push({ name, dates: [] });
    saveHabits();
    render();
    input.value = "";
  });
});
