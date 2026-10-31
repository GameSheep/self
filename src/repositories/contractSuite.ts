/**
 * Shared contract suite (P2-01).
 * One list of checks, run against **both** implementations. The plan's
 * requirement is literal: "用例仅依赖仓库契约；Legacy 和 IndexedDB 实现可用同一组
 * · 契约测试验证". A check may only use the `HubRepository` surface, so a check
 */
import type { HubRepository } from './contract';

export interface ContractCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

async function check(name: string, run: () => Promise<void>): Promise<ContractCheckResult> {
  try {
    await run();
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; userMessage: string } }): T {
  assert(result.ok, `期望成功，实际失败: ${result.ok ? '' : `${result.error.code} ${result.error.userMessage}`}`);
  return result.value;
}

function expectFail(result: { ok: boolean; error?: { code: string } }): { code: string } {
  assert(!result.ok, '期望被拒绝，实际成功了');
  return result.error as { code: string };
}

export interface ContractSuiteOptions {
  /** Prefix for entity ids so repeated runs never collide. */
  runId: string;
}

export async function runContractSuite(
  repo: HubRepository,
  options: ContractSuiteOptions
): Promise<ContractCheckResult[]> {
  const runId = options.runId;
  const noteId = `${runId}-note`;
  const projectId = `${runId}-proj`;
  const results: ContractCheckResult[] = [];

  results.push(
    await check('初始化后可读取内容版本', async () => {
      expectOk(await repo.init());
      const revision = expectOk(await repo.getContentRevision());
      assert(typeof revision === 'number' && revision >= 0, `内容版本应为非负数字，实际 ${revision}`);
    })
  );

  results.push(
    await check('创建项目', async () => {
      const created = expectOk(await repo.createProject({ id: projectId, name: `契约测试项目 ${runId}` }));
      assert(created.id === projectId, `项目 id 应为 ${projectId}`);
    })
  );

  results.push(
    await check('保存笔记会同时写入条目与正文', async () => {
      const saved = expectOk(
        await repo.saveNote({
          id: noteId,
          title: '契约测试笔记',
          markdown: '# 正文\n\n内容',
          tags: ['契约'],
          projectIds: [projectId]
        })
      );
      assert(saved.item.id === noteId, '条目 id 不一致');
      assert(saved.body.markdown.includes('内容'), '正文未保存');

      const read = expectOk(await repo.getNote(noteId));
      assert(read, '保存后应能读回笔记');
      assert(read!.body.markdown.includes('内容'), '读回的正文不匹配');
      assert(read!.item.projectIds.includes(projectId), '条目应记录项目引用');
    })
  );

  results.push(
    await check('保存笔记会递增自身 revision，且不会丢掉已有关联', async () => {
      const first = expectOk(await repo.getNote(noteId));
      // Note the deliberate omission of projectIds: editing a title must not
      // silently drop the note out of its projects.
      const saved = expectOk(await repo.saveNote({ id: noteId, title: '契约测试笔记', markdown: '# 改过了' }));
      assert(
        saved.item.revision > first!.item.revision,
        `revision 应递增：${first!.item.revision} → ${saved.item.revision}`
      );
      assert(
        saved.item.projectIds.includes(projectId),
        '未提供 projectIds 时应保留原有关联'
      );
      const links = expectOk(await repo.listLinks({ fromId: noteId }));
      assert(links.length === 1, `保留关联时仍应有一条项目关联，实际 ${links.length}`);
    })
  );

  results.push(
    await check('项目引用会写成可查询的关联', async () => {
      const links = expectOk(await repo.listLinks({ fromId: noteId }));
      assert(links.length === 1, `应有一条项目关联，实际 ${links.length}`);
      assert(links[0].toId === projectId, '关联目标不是该项目');
    })
  );

  results.push(
    await check('引用不存在的项目会被拒绝，且不留下半条记录', async () => {
      const ghostNoteId = `${runId}-ghost`;
      const before = expectOk(await repo.getContentRevision());
      const failure = expectFail(
        await repo.saveNote({
          id: ghostNoteId,
          title: '不应存在的笔记',
          markdown: '不应存在的正文',
          projectIds: [`${runId}-missing-project`]
        })
      );
      assert(failure.code === 'VALIDATION', `应为 VALIDATION，实际 ${failure.code}`);

      // The whole point: the item and the body must not exist afterwards.
      const readBack = expectOk(await repo.getNote(ghostNoteId));
      assert(!readBack, '被拒绝的笔记不应存在');
      const listed = expectOk(await repo.listItems({ search: '不应存在的笔记' }));
      assert(listed.length === 0, '被拒绝的笔记不应出现在列表里');
      const after = expectOk(await repo.getContentRevision());
      assert(after === before, `被拒绝的写入不应改变内容版本：${before} → ${after}`);
    })
  );

  results.push(
    await check('列表可按项目与关键字过滤', async () => {
      const byProject = expectOk(await repo.listItems({ projectId }));
      assert(
        byProject.some((i) => i.id === noteId),
        '按项目过滤应能找到该笔记'
      );
      const bySearch = expectOk(await repo.listItems({ search: '契约测试' }));
      assert(
        bySearch.some((i) => i.id === noteId),
        '按关键字应能找到该笔记'
      );
      const byKind = expectOk(await repo.listItems({ kind: 'bookmark' }));
      assert(
        !byKind.some((i) => i.id === noteId),
        'kind 过滤不应把笔记算成书签'
      );
    })
  );

  results.push(
    await check('收件箱记录按 operationId 幂等', async () => {
      const operationId = `${runId}-cap`;
      const first = expectOk(
        await repo.captureInbox({ rawText: '契约测试记录', operationId, source: 'home' })
      );
      assert(first.created, '首次记录应标记为新建');
      const second = expectOk(
        await repo.captureInbox({ rawText: '契约测试记录', operationId, source: 'home' })
      );
      assert(!second.created, '重复提交不应再创建一条');
      assert(second.entry.id === first.entry.id, '重复提交应返回同一条记录');

      const all = expectOk(await repo.listInbox('inbox'));
      const matching = all.filter((e) => e.operationId === operationId);
      assert(matching.length === 1, `同一 operationId 只应有一条记录，实际 ${matching.length}`);
    })
  );

  results.push(
    await check('空内容与缺少幂等键会被拒绝', async () => {
      const empty = expectFail(await repo.captureInbox({ rawText: '   ', operationId: `${runId}-empty`, source: 'home' }));
      assert(empty.code === 'VALIDATION', `空内容应为 VALIDATION，实际 ${empty.code}`);
      const noKey = expectFail(await repo.captureInbox({ rawText: '内容', operationId: '', source: 'home' }));
      assert(noKey.code === 'VALIDATION', `缺少幂等键应为 VALIDATION，实际 ${noKey.code}`);
    })
  );

  results.push(
    await check('收件箱转换会写入目标并记录引用，重复转换不新建', async () => {
      const operationId = `${runId}-convert`;
      const captured = expectOk(
        await repo.captureInbox({ rawText: '要转换的内容', operationId, source: 'inbox' })
      );
      const converted = expectOk(
        await repo.convertInboxEntry(captured.entry.id, {
          type: 'note',
          title: '转换后的笔记',
          markdown: '转换后的正文'
        })
      );
      assert(converted.created, '首次转换应标记为新建');
      assert(converted.entry.status === 'processed', '转换后状态应为已处理');
      assert(
        converted.entry.resultRefs.some((ref) => ref.id === converted.targetId),
        '转换结果应记录在 resultRefs 里'
      );

      const target = expectOk(await repo.getNote(converted.targetId));
      assert(target, '转换后的目标笔记应存在');

      const again = expectOk(
        await repo.convertInboxEntry(captured.entry.id, {
          type: 'note',
          title: '转换后的笔记',
          markdown: '转换后的正文'
        })
      );
      assert(!again.created, '重复转换不应再次创建');
      assert(again.targetId === converted.targetId, '重复转换应返回原目标');

      const inbox = expectOk(await repo.listInbox());
      assert(
        inbox.filter((e) => e.operationId === operationId).length === 1,
        '收件箱条目不应因重复转换而增加'
      );
    })
  );

  results.push(
    await check('内容版本随提交递增，并发出变更事件', async () => {
      const events: number[] = [];
      const unsubscribe = repo.subscribe((event) => events.push(event.contentRevision));
      const before = expectOk(await repo.getContentRevision());
      expectOk(
        await repo.saveNote({ id: `${runId}-watch`, title: '变更事件笔记', markdown: '内容' })
      );
      const after = expectOk(await repo.getContentRevision());
      unsubscribe();

      assert(after > before, `内容版本应递增：${before} → ${after}`);
      assert(events.length >= 1, '应至少收到一次变更事件');
      assert(
        events[events.length - 1] === after,
        `事件里的版本应与存储一致：事件 ${events[events.length - 1]} / 存储 ${after}`
      );

      // After unsubscribing, no further events arrive.
      const countAfterUnsubscribe = events.length;
      expectOk(await repo.saveNote({ id: `${runId}-watch2`, title: '订阅已取消', markdown: '内容' }));
      assert(events.length === countAfterUnsubscribe, '取消订阅后不应再收到事件');
    })
  );

  results.push(
    await check('软删除会从默认列表隐藏，但仍可显式查询', async () => {
      const id = `${runId}-trash`;
      expectOk(await repo.saveNote({ id, title: '待删除笔记', markdown: '内容' }));
      expectOk(await repo.deleteNote(id));

      const visible = expectOk(await repo.listItems({ search: '待删除笔记' }));
      assert(!visible.some((i) => i.id === id), '软删除后不应出现在默认列表');
      const withDeleted = expectOk(await repo.listItems({ search: '待删除笔记', includeDeleted: true }));
      assert(
        withDeleted.some((i) => i.id === id),
        '显式包含已删除时仍应能查到（回收站依赖这一点）'
      );
      const read = expectOk(await repo.getNote(id));
      assert(!read, '软删除的笔记不应能按 id 读出正文');
    })
  );

  results.push(
    await check('删除不存在的笔记会返回 NOT_FOUND', async () => {
      const failure = expectFail(await repo.deleteNote(`${runId}-never-existed`));
      assert(failure.code === 'NOT_FOUND', `应为 NOT_FOUND，实际 ${failure.code}`);
    })
  );

  return results;
}
