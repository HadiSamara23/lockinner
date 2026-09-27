// lockInner — the coach's voice.
// Affectionate mockery: roast the procrastination, never the person.
// Placeholders: {n} task name, {left} time left, {snz} snooze count, {streak} on-it streak, {why} blocker.
// Heat 1 = Mild (the original calm check-ins live here), 2 = Spicy, 3 = Unhinged.
window.LI_VOICE = (function () {
  const P = {
    early: {
      1: [
        'Still with "{n}"?',
        '"{n}" — five minutes right now?',
        'Quick check-in: any movement on "{n}"?',
        'Where are things on "{n}"?',
        '"{n}". Now\'s as good a time as any.',
        'No pressure. Well, some pressure. "{n}"?'
      ],
      2: [
        '"{n}" has {left}. So do you. That\'s how deadlines work.',
        'Friendly reminder that "{n}" won\'t do itself. I checked.',
        'You said "{n}" like you meant it. Did you?',
        'I\'m not mad, I\'m just asking about "{n}".',
        '{left} left on "{n}". Plenty of time to start. Ideally now.',
        'Is that "{n}" you\'re doing, or is that your phone? Asking for a deadline.'
      ],
      3: [
        '"{n}" called. It says you ghosted it.',
        'Future you has words about "{n}". Mostly swear words.',
        'I\'ve seen glaciers with more momentum than "{n}".',
        '"{n}". {left} left. Stop reorganizing your desk.',
        'Imagine finishing "{n}" today. Wild concept, I know.',
        'You\'re reading a notification, which means you\'re not doing "{n}". Busted.'
      ]
    },
    mid: {
      1: [
        'Halfway to the deadline on "{n}". How\'s it looking?',
        'Deadline\'s getting closer on "{n}".',
        '"{n}" is waiting.',
        'Small step on "{n}"? Even a tiny one counts.',
        '{left} left for "{n}". One focused block would do a lot.'
      ],
      2: [
        'Half the time is gone. Is half of "{n}"? Be honest.',
        '"{n}" is starting to look at its watch.',
        'The clock on "{n}" is moving. Are you?',
        '{left} left. "{n}" is not going to finish itself out of pity.',
        'Plot twist: "{n}" still needs you. Cliché, I know.'
      ],
      3: [
        '{left} left on "{n}" and the vibes are… not great.',
        '"{n}" is now officially a "later" problem. Later is arriving.',
        'The deadline for "{n}" can see you. It\'s waving.',
        'You\'ve had half the time for "{n}". What did you do with it? Don\'t answer. Work.',
        'At this pace "{n}" gets done in the sequel.'
      ]
    },
    close: {
      1: [
        'Only {left} left on "{n}". Good moment to close it out.',
        '"{n}" — final stretch. You\'ve got this.',
        'Almost there on "{n}". One more push?'
      ],
      2: [
        'Boarding now: "{n}". {left} until the doors close.',
        '{left}. "{n}". This is the part where you actually do it.',
        '"{n}" is due in {left}. Adrenaline is technically a productivity tool.'
      ],
      3: [
        'FINAL CALL for "{n}". {left}. Run.',
        '{left} left on "{n}". Ah yes, the classic last-minute special.',
        '"{n}". {left}. Panic is allowed, but do it while typing.',
        'The deadline for "{n}" is so close it can smell your excuses.'
      ]
    },
    // Fires at the exact deadline if the lockin isn't done. The deadline is the one thing that matters: no softening.
    deadline: {
      1: [
        'Deadline for "{n}" is now, and it isn\'t done. Finish it, or be honest and set a new one.',
        '"{n}" was due just now. Not done. Let\'s close it out.',
        'Time\'s up on "{n}". Still open. What\'s the plan?'
      ],
      2: [
        'Time\'s up on "{n}". You said this mattered. It\'s not done.',
        '"{n}": deadline, right now. Not done. Explain yourself (by finishing it).',
        'That was the deadline for "{n}". The one you picked. Yourself.',
        'Deadline hit. "{n}" is still sitting there. Awkward.'
      ],
      3: [
        'DEADLINE. "{n}". NOT DONE. I\'m not mad, I\'m just deeply, deeply disappointed.',
        'You had one job: "{n}". The clock just ran out on it.',
        '"{n}" missed its deadline. Future you just filed a complaint.',
        'Time\'s up. "{n}" is officially late. Your excuses are not on the board.',
        'The deadline for "{n}" came and went. So did your credibility. Fix it.'
      ]
    },
    overdue: {
      1: ['The deadline for "{n}" just passed. Want to set a new one, or wrap it up now?'],
      2: ['"{n}" missed its train. Next one leaves when you open the app.', 'Deadline for "{n}": gone. Dignity: recoverable. Tap in.'],
      3: ['"{n}" departed without you. It waved. You were busy "resting your eyes".', 'Overdue: "{n}". I\'m not angry. I\'m writing this down.']
    },
    notyet: {
      1: ['Checking back on "{n}", like I said I would.', 'You said not yet. Is it yet now? "{n}"'],
      2: ['Round two on "{n}". You said "not yet" an hour ago. Not yet-yet?', '"Not yet" has expired. "{n}"?'],
      3: ['You said "not yet". I said "fine". I lied. "{n}", now.', 'Back again about "{n}". I have no life. You have {left}.']
    },
    snoozed: {
      1: ['Snooze over. "{n}"?'],
      2: ['Snooze #{snz} on "{n}". Bold strategy. Let\'s see if it pays off.', 'Good morning from your snooze button. "{n}" is still here.'],
      3: ['{snz} snoozes on "{n}". At this point you\'re in a relationship with the snooze button.', 'Snooze #{snz}. "{n}" has filed a missing person report.']
    },
    onit: {
      1: ['You said you were on "{n}". How\'d it go?', 'Checking in after that push on "{n}". Nice work if it moved.'],
      2: ['{streak} "on it"s in a row on "{n}". Suspiciously productive. Still going?', 'You were "on it" with "{n}". Still on it, or on your phone?'],
      3: ['You said "on it" about "{n}". The evidence, please.', '"On it", you said. Very confident. "{n}" wants receipts.']
    },
    blocked: {
      1: ['Still blocked on "{n}" by "{why}"? Maybe one tiny thing moves it.'],
      2: ['"{why}" has been blocking "{n}" for a while now. Poke it with a stick?'],
      3: ['"{why}" vs. "{n}". It\'s been hours. Pick a side and fight.']
    },
    morning: [
      'Morning. Coffee is not a task. "{n}" is.',
      'New day, same "{n}". Let\'s make this the day it dies (gets finished).'
    ],
    late: [
      'It\'s late. "{n}" still isn\'t done. Sleep is for the finished.',
      'Evening report: "{n}" — pending. Your couch — occupied.'
    ],
    refill: [
      'I\'ve run out of pre-scheduled nagging. Open lockInner so I can keep bothering you.',
      'Nag supply depleted. Open lockInner to restock. (Your tasks miss me.)'
    ],
    done: [
      'Look at you. "{n}" — DONE. I\'ll pretend I never doubted you.',
      '"{n}" departed on time. I\'m… proud? Weird feeling.',
      'Done! "{n}" is off the board. Frame this moment.',
      '"{n}", finished. The coach is speechless. Briefly.',
      'You did "{n}". Somewhere, a deadline is crying.'
    ],
    ack: {
      onit: ['Love that. I\'ll back off for a bit.', 'Noted. Going quiet. Don\'t make me regret it.', 'Good. I\'ll be over here, pretending not to watch.'],
      notyet: ['Fine. I\'ll be back sooner. And spicier.', 'Noted. I\'ll check again in about an hour.', 'Okay. The clock heard that too.'],
      blocked: ['Paused. Go unblock it. I\'ll check back in a few hours.', 'Got it. Nudges paused until you unblock.'],
      unblock: ['Back in business. The nagging resumes.', 'Unblocked. Let\'s go.']
    }
  };

  const TITLES = {
    early: ['📢 Platform announcement', '🎙️ A word from your coach', '🚉 Service update'],
    mid: ['📢 Platform announcement', '🕰️ Halfway mark', '🎙️ Coach, again'],
    close: ['⏰ Boarding now', '🚨 Final call'],
    deadline: ['⛔ Deadline hit', '🚨 Time\'s up', '⛔ Not done. Deadline.'],
    overdue: ['🧯 Delayed service'],
    notyet: ['🐌 Checking back'],
    snoozed: ['😴 Snooze report'],
    onit: ['💪 Progress check'],
    blocked: ['🧱 Still blocked?'],
    refill: ['🔋 Nag supply low']
  };

  const pick = a => a[Math.floor(Math.random() * a.length)];
  const fill = (s, c) => s.replace(/\{(\w+)\}/g, (_, k) => (c[k] != null ? c[k] : ''));

  function compose(kind, c) {
    const heat = Math.max(1, Math.min(3, c.heat || 2));
    let pool = P[kind] && P[kind][heat] ? P[kind][heat] : (P[kind] && P[kind][2]) || P.early[2];
    if ((kind === 'early' || kind === 'mid') && heat > 1 && Math.random() < 0.25) {
      if (c.hour < 11) pool = P.morning;
      else if (c.hour >= 20) pool = P.late;
    }
    if (kind === 'refill') pool = P.refill;
    return { title: pick(TITLES[kind] || TITLES.early), text: fill(pick(pool), c) };
  }

  return {
    compose,
    done: c => fill(pick(P.done), c),
    ack: kind => pick(P.ack[kind] || ['Noted.'])
  };
})();
