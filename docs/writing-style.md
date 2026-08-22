# WTS writing style

WTS uses Simplified Technical English for all user-facing technical prose.

The rule applies to these surfaces:

- user interface text
- agent status text
- errors and recovery instructions
- project documentation
- code comments that explain behavior
- pull request descriptions and release notes

The project adapts these rules from the [STE writing skill](https://github.com/woosal1337/blog/blob/main/videos/ep01-the-cure-for-ai-slop/ste-writing-skill.md).

## Choose a mode

Use strict mode for these types of text:

- procedures
- setup instructions
- warnings
- safety information
- error messages
- recovery steps
- user interface instructions
- agent states, activities, and results

Use STE-flavored mode for these types of text:

- README files
- architecture documents
- product documents
- decision records
- test plans
- pull request descriptions

Strict mode uses every rule in this guide. STE-flavored mode permits necessary technical words.

## Use consistent words

Use one name for one thing. Do not change names to add variety.

Use short common words. For example, use `start` instead of `initiate`.

Use `use` instead of `utilize`. Use `help` instead of `facilitate`.

Use `make sure` instead of `ensure`. Use `show` instead of `demonstrate`.

Do not use marketing claims. Avoid words such as `seamless`, `robust`, and `world-class`.

Do not use formal filler. For example, use `before` instead of `prior to`.

Do not use phrases such as `in order to`, `a variety of`, or `it is important to note`.

Do not use a phrasal verb when a direct verb works. Use `start` instead of `spin up`.

Avoid status fragments that end in `-ing`. Use `Runs a command` instead of `Running a command`.

Use American spelling.

## Write direct sentences

Use active voice when the actor is known. Name the actor before the action.

Use a verb for an action. Write "analyze the log," not "perform an analysis."

Do not use a noun to hide an action. Write "WTS verifies the plan," not "WTS performs verification of the plan."

Do not stack auxiliary verbs. Remove phrases such as `it is important to note`.

Do not use modal hedges. Remove phrases such as `it should be noted` and `as noted above`.

Use a simple verb instead of an `-ing` main verb when possible.

Write one instruction in each sentence. Keep an instruction at 20 words or fewer.

Keep a descriptive sentence at 25 words or fewer. Split a long sentence at a logical boundary.

Do not use contractions. Use articles such as "a," "an," and "the."

Do not use semicolons. Use two sentences instead.

## Structure the text

Keep one topic in each paragraph. Limit a paragraph to six sentences.

Use a numbered vertical list for a procedure. Start each step with an imperative verb.

Put a condition before its instruction. Make each step contain one action.

Preserve exact code, commands, identifiers, API fields, and interface labels. Do not rewrite quoted text that must match the product.

## Write interface status text

Name the actor when space permits. Use `Codex is active` instead of `Working`.

Use the simple present tense for an activity. Use `Runs tests` instead of `Running tests`.

State the result before the source or implementation detail. Use `Codex finished` before `Observed locally`.

Do not show an internal event name as interface text. Translate the event into a direct user action or state.

Keep a status label short. Put supporting facts in a separate sentence or metadata row.

Do not rewrite agent result content. WTS can remove unsafe formatting and paths, but it must preserve the agent's meaning.

## Review the result

Before you finish, check the prose with this list:

1. Split sentences that exceed the applicable word limit.
2. Replace each semicolon with a period.
3. Expand each contraction.
4. Change passive voice when the actor is known.
5. Replace nominalizations and unnecessary `-ing` verbs.
6. Replace phrasal verbs and modal hedges.
7. Use one name for each item.
8. Remove claims that do not provide technical information.

A mechanical check can find only some errors. A writer must still check meaning, accuracy, and useful technical detail.
