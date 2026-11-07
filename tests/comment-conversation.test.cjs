// functions/comment-conversation.js: a comment thread made a conversation — its title, its text, its page.
const test = require('node:test');
const assert = require('node:assert');
const { titleOf, bodyOf, pageOf } = require('../functions/comment-conversation');
const { guideArea } = require('../functions/access');

test('the title is the first comment’s first line, shortened at a word', () => {
  assert.strictEqual(titleOf('Should this say *weekly*?\nI think fortnightly.', 'q'), 'Should this say *weekly*?');
  assert.strictEqual(titleOf('> quoted\n\n- a point', ''), 'quoted');
  const long = titleOf('word '.repeat(60), '');
  assert.ok(long.length <= 120 && long.endsWith('…') && !/\s…$/.test(long));
});
test('with no words of its own, the title is the passage', () => {
  assert.strictEqual(titleOf('', ' the lab meets weekly '), 'On “the lab meets weekly”');
});
test('the text quotes the passage, every line, then the comment', () => {
  assert.strictEqual(bodyOf('one\ntwo', 'Why?'), '> one\n> two\n\nWhy?');
  assert.strictEqual(bodyOf('', 'Why?'), 'Why?');
});
test('only the BOLDiquette and guides, each with its area and page', () => {
  assert.deepStrictEqual(pageOf('handbook/boldiquette', guideArea), { collection: 'handbook', slug: 'boldiquette', area: 'boldiquette', href: 'boldiquette.html' });
  assert.deepStrictEqual(pageOf('guides/how-to-submit', guideArea), { collection: 'guides', slug: 'how-to-submit', area: 'guides', href: 'guide.html?guide=how-to-submit' });
  assert.strictEqual(pageOf('guides/get-started-at-bold', guideArea).area, 'get-started');
  assert.strictEqual(pageOf('handbook/other', guideArea), null);
  assert.strictEqual(pageOf('members/x', guideArea), null);
  assert.strictEqual(pageOf('guides/../x', guideArea), null);
});
const { cardOf } = require('../functions/comment-conversation');
test('a card’s comments: its project and card, and the one post they become', () => {
  assert.deepStrictEqual(cardOf('card/card-1789-ab/w9X'), { pid: 'card-1789-ab', card: 'w9X', id: 'cm-card-card-1789-ab-w9X' });
  assert.strictEqual(cardOf('card/a'), null);
  assert.strictEqual(cardOf('card/a/b/c'), null);
  assert.strictEqual(cardOf('card/../b'), null);
});

const { changeOf } = require('../functions/comment-conversation');
test('a proposed change’s discussion: its page and proposal, and the one post it becomes', () => {
  assert.deepStrictEqual(changeOf('change/handbook/boldiquette/AbC12'), { collection: 'handbook', slug: 'boldiquette', proposal: 'AbC12', id: 'cm-change-handbook-boldiquette-AbC12' });
  assert.strictEqual(changeOf('change/guides/how-to-submit/x9').id, 'cm-change-guides-how-to-submit-x9');
  assert.strictEqual(changeOf('change/handbook/other/x'), null);
  assert.strictEqual(changeOf('change/guides/../x'), null);
});

const { reviewOf, discussionOf } = require('../functions/comment-conversation');
test('an Internal Review card’s Discussion: its board and card, and its old messages in order', () => {
  assert.deepStrictEqual(reviewOf('review/iclr-2027/card-1-ab'), { board: 'iclr-2027', card: 'card-1-ab', id: 'cm-review-iclr-2027-card-1-ab' });
  assert.strictEqual(reviewOf('review/x'), null);
  const d = discussionOf([{ author: 'A', authorEmail: 'A@x', timestamp: 1, body: 'one', replies: [{ author: 'B', authorEmail: 'b@x', timestamp: 2, body: 'two' }] }, { author: 'C', authorEmail: 'c@x', timestamp: 3, body: 'three' }]);
  assert.deepStrictEqual(d.map((m) => m.text + '/' + m.by.email + '/' + m.at), ['one/a@x/1', 'two/b@x/2', 'three/c@x/3']);
  assert.deepStrictEqual(discussionOf(undefined), []);
});

const { descriptionOf } = require('../functions/comment-conversation');
test('a card’s description as its first message: its notes, then its images; only https images', () => {
  assert.strictEqual(descriptionOf({ notes: ' Do X. ', images: [{ name: 'fig [1]', url: 'https://a/b.png' }, { url: 'javascript:alert(1)' }] }), 'Do X.\n\n![fig 1](https://a/b.png)');
  assert.strictEqual(descriptionOf({}), '');
  assert.strictEqual(descriptionOf({ images: [{ url: 'https://a/c.png' }] }), '![An image](https://a/c.png)');
});
