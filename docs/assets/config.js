/* 站点配置。这个文件会被公开发布，只能放"可公开"的值。
 *
 * Supabase 的 anon key 本来就是公开的：数据库开启了 RLS，
 * anon 角色只有 INSERT 权限，读不到任何人的作答。
 * 千万不要把 service_role key 写进这里。
 */
window.SURVEY_CONFIG = {
  version: "1.1.0",
  studyName: "MIXIDIOM-69 字形保真人工标注",

  // 联系方式（做完可改成邮箱；留空则用 GitHub 主页）
  contactEmail: "",
  contactUrl: "https://github.com/Azhe2002",

  // 建好 Supabase 项目后填入。两种 key 都支持：
  //   旧版 anon public: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...."
  //   新版 publishable: "sb_publishable_..."
  // 留空时页面仍可作答，结果保存在本机并可在结束页下载；
  // 填好后重新部署即可自动上传。
  supabaseUrl: "https://pzgtwmiilmenzfevfkgl.supabase.co",
  supabaseAnonKey: "sb_publishable_5uwJpH4LbqpCtQPBLXi2tQ_dg6kSlZK",

  // 每答多少题额外上传一个进度快照（答卷完成时总会再传一次）
  syncEveryN: 15
};
