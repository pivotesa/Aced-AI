export const SUBJECTS = {
  'Mathematics': {
    papers: ['Paper 1', 'Paper 2'],
    topics: {
      'Paper 1': ['Algebra and equations', 'Patterns and sequences', 'Functions and graphs', 'Logarithms', 'Financial mathematics', 'Probability'],
      'Paper 2': ['Statistics', 'Analytical geometry', 'Trigonometry (2D)', 'Trigonometry (3D)', 'Euclidean geometry']
    }
  },
  'Physical Sciences': {
    papers: ['Physics', 'Chemistry'],
    topics: {
      'Physics': ['Momentum and impulse', 'Work, energy and power', 'Doppler effect', 'Electrostatics', 'Electric circuits', 'Electromagnetism', 'Optical phenomena'],
      'Chemistry': ['Organic chemistry', 'Chemical equilibrium', 'Acids and bases', 'Electrochemistry', 'Chemical industry']
    }
  },
  'English Home Language': {
    papers: ['Paper 1: Language', 'Paper 2: Literature', 'Paper 3: Writing'],
    topics: {
      'Paper 1: Language': ['Comprehension', 'Summary', 'Language use and conventions'],
      'Paper 2: Literature': ['Poetry', 'Novel', 'Drama', 'Short stories'],
      'Paper 3: Writing': ['Essay', 'Transactional writing', 'Creative writing']
    }
  },
  'Life Sciences': {
    papers: ['Paper 1', 'Paper 2'],
    topics: {
      'Paper 1': ['DNA and RNA', 'Meiosis', 'Reproduction', 'Genetics and inheritance', 'Evolution'],
      'Paper 2': ['Nervous system', 'Endocrine system', 'Homeostasis', 'Human impact on environment', 'Ecosystems']
    }
  },
  'Accounting': {
    papers: ['Paper 1'],
    topics: {
      'Paper 1': ['Financial statements', 'Asset disposal', 'Bank reconciliation', 'Debtors and creditors', 'VAT', 'Budgets and projections', 'Interpretation of financial statements']
    }
  }
};

export function getPapers(subject) {
  return SUBJECTS[subject]?.papers ?? [];
}

export function getTopics(subject, paper) {
  return SUBJECTS[subject]?.topics[paper] ?? [];
}
