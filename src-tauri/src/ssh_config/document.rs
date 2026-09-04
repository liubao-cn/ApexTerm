//! 无损往返的 ssh_config 文档模型。
//!
//! 设计原则：原始每一行都按原样保存在 `lines` 中，解析结果只是这些行的“视图”。
//! 任何修改都只改动涉及的行，其余注释、空行、缩进、未知字段一律原样保留，
//! 因此 `parse(x).render() == x` 恒成立。

use std::path::PathBuf;

pub const INDENT_DEFAULT: &str = "    ";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directive {
    pub line: usize,
    pub indent: String,
    pub key: String,
    pub sep: String,
    pub value: String,
    pub comment: String,
}

impl Directive {
    pub fn render(&self) -> String {
        format!("{}{}{}{}{}", self.indent, self.key, self.sep, self.value, self.comment)
    }

    pub fn key_is(&self, key: &str) -> bool {
        self.key.eq_ignore_ascii_case(key)
    }

    pub fn unquoted(&self) -> String {
        unquote(&self.value)
    }
}

pub fn unquote(v: &str) -> String {
    let t = v.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

pub fn quote_if_needed(v: &str) -> String {
    let already = v.len() >= 2 && v.starts_with('"') && v.ends_with('"');
    if v.contains(char::is_whitespace) && !already {
        format!("\"{v}\"")
    } else {
        v.to_string()
    }
}

/// 找到未被引号包裹、且位于 token 开头的 `#`，返回其下标；没有则返回 s.len()。
fn comment_start(s: &str) -> usize {
    let mut in_quotes = false;
    let mut prev_ws = true;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            '#' if !in_quotes && prev_ws => return i,
            _ => {}
        }
        prev_ws = c.is_whitespace();
    }
    s.len()
}

fn parse_directive(raw: &str, line: usize) -> Option<Directive> {
    let indent_len = raw.len() - raw.trim_start().len();
    let (indent, rest) = raw.split_at(indent_len);
    if rest.is_empty() || rest.starts_with('#') {
        return None;
    }
    let key_len = rest
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(rest.len());
    let (key, after) = rest.split_at(key_len);
    let sep_len = after.len()
        - after
            .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
            .len();
    let (sep, remainder) = after.split_at(sep_len);
    let cut = comment_start(remainder);
    let value = remainder[..cut].trim_end();
    let comment = &remainder[value.len()..];
    Some(Directive {
        line,
        indent: indent.to_string(),
        key: key.to_string(),
        sep: sep.to_string(),
        value: value.to_string(),
        comment: comment.to_string(),
    })
}

fn is_comment(raw: &str) -> bool {
    raw.trim_start().starts_with('#')
}

fn is_blank(raw: &str) -> bool {
    raw.trim().is_empty()
}

fn split_patterns(value: &str) -> Vec<String> {
    value.split_whitespace().map(unquote).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Host,
    Match,
}

#[derive(Debug, Clone)]
pub struct Block {
    pub kind: BlockKind,
    /// 紧贴在 Host 行上方的连续注释行起点（没有则等于 header）
    pub comment_start: usize,
    /// `Host ...` 所在行
    pub header: usize,
    /// 半开区间终点：下一个块的 comment_start 或文件末尾（含块后的空行）
    pub end: usize,
    pub header_directive: Directive,
    pub patterns: Vec<String>,
    pub directives: Vec<Directive>,
}

#[derive(Debug, Clone)]
pub struct Document {
    pub path: PathBuf,
    pub lines: Vec<String>,
    pub trailing_newline: bool,
    pub globals: Vec<Directive>,
    pub blocks: Vec<Block>,
}

impl Document {
    pub fn parse(path: impl Into<PathBuf>, content: &str) -> Document {
        let mut lines: Vec<String> = if content.is_empty() {
            Vec::new()
        } else {
            content.split('\n').map(str::to_string).collect()
        };
        let trailing_newline = content.is_empty() || content.ends_with('\n');
        if content.ends_with('\n') {
            lines.pop();
        }
        let mut doc = Document {
            path: path.into(),
            lines,
            trailing_newline,
            globals: Vec::new(),
            blocks: Vec::new(),
        };
        doc.reparse();
        doc
    }

    pub fn render(&self) -> String {
        let mut s = self.lines.join("\n");
        if self.trailing_newline && !self.lines.is_empty() {
            s.push('\n');
        }
        s
    }

    fn comment_run_start(&self, header: usize) -> usize {
        let mut s = header;
        while s > 0 && is_comment(&self.lines[s - 1]) {
            s -= 1;
        }
        s
    }

    fn reparse(&mut self) {
        self.globals.clear();
        self.blocks.clear();
        let mut current: Option<Block> = None;
        for i in 0..self.lines.len() {
            let Some(d) = parse_directive(&self.lines[i], i) else {
                continue;
            };
            if d.key_is("Host") || d.key_is("Match") {
                let comment_start = self.comment_run_start(i);
                if let Some(mut b) = current.take() {
                    b.end = comment_start;
                    self.blocks.push(b);
                }
                let kind = if d.key_is("Host") {
                    BlockKind::Host
                } else {
                    BlockKind::Match
                };
                current = Some(Block {
                    kind,
                    comment_start,
                    header: i,
                    end: self.lines.len(),
                    patterns: split_patterns(&d.value),
                    header_directive: d,
                    directives: Vec::new(),
                });
            } else if let Some(b) = current.as_mut() {
                b.directives.push(d);
            } else {
                self.globals.push(d);
            }
        }
        if let Some(b) = current {
            self.blocks.push(b);
        }
    }

    /// 块的“内容终点”：去掉块尾空行后的半开区间终点
    fn content_end(&self, b: &Block) -> usize {
        let mut e = b.end;
        while e > b.header + 1 && is_blank(&self.lines[e - 1]) {
            e -= 1;
        }
        e
    }

    pub fn block_raw(&self, idx: usize) -> String {
        let b = &self.blocks[idx];
        self.lines[b.comment_start..self.content_end(b)].join("\n")
    }

    /// 块上方注释去掉 `#` 后拼成的描述
    pub fn block_description(&self, idx: usize) -> Option<String> {
        let b = &self.blocks[idx];
        let text = self.lines[b.comment_start..b.header]
            .iter()
            .map(|l| l.trim_start().trim_start_matches('#').trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        (!text.is_empty()).then_some(text)
    }

    fn block_indent(&self, b: &Block) -> String {
        b.directives
            .iter()
            .map(|d| d.indent.clone())
            .find(|s| !s.is_empty())
            .unwrap_or_else(|| INDENT_DEFAULT.to_string())
    }

    /// 文件整体使用的缩进风格（取第一个有子项的块）
    pub fn preferred_indent(&self) -> String {
        self.blocks
            .iter()
            .find(|b| !b.directives.is_empty())
            .map(|b| self.block_indent(b))
            .unwrap_or_else(|| INDENT_DEFAULT.to_string())
    }

    /// 把块内某个 key 的全部取值设置为 `values`（顺序一致）。空切片表示删除该 key。
    /// 已有行原地改值并保留缩进/分隔符/行尾注释；多出来的删除；不够的紧跟同名行之后插入。
    pub fn set_directive(&mut self, idx: usize, key: &str, values: &[String]) {
        let existing: Vec<usize> = self.blocks[idx]
            .directives
            .iter()
            .filter(|d| d.key_is(key))
            .map(|d| d.line)
            .collect();
        if existing.len() > values.len() {
            for &line in existing[values.len()..].iter().rev() {
                self.lines.remove(line);
            }
            self.reparse();
        }
        let block = &self.blocks[idx];
        let existing: Vec<Directive> = block
            .directives
            .iter()
            .filter(|d| d.key_is(key))
            .cloned()
            .collect();
        let indent = self.block_indent(block);
        let key_text = existing
            .first()
            .map(|d| d.key.clone())
            .unwrap_or_else(|| key.to_string());
        let sep = existing
            .first()
            .map(|d| d.sep.clone())
            .unwrap_or_else(|| " ".to_string());
        let mut insert_at = existing
            .last()
            .or(block.directives.last())
            .map(|d| d.line + 1)
            .unwrap_or(block.header + 1);
        for (i, v) in values.iter().enumerate() {
            let v = quote_if_needed(v);
            if let Some(d) = existing.get(i) {
                let mut nd = d.clone();
                nd.value = v;
                self.lines[d.line] = nd.render();
            } else {
                self.lines
                    .insert(insert_at, format!("{indent}{key_text}{sep}{v}"));
                insert_at += 1;
            }
        }
        self.reparse();
    }

    pub fn set_patterns(&mut self, idx: usize, patterns: &[String]) {
        let b = &self.blocks[idx];
        let mut d = b.header_directive.clone();
        d.value = patterns
            .iter()
            .map(|p| quote_if_needed(p))
            .collect::<Vec<_>>()
            .join(" ");
        self.lines[b.header] = d.render();
        self.reparse();
    }

    /// 替换块上方的注释行（描述）。空文本表示删除注释。
    pub fn set_description(&mut self, idx: usize, text: &str) {
        let b = &self.blocks[idx];
        let (start, header) = (b.comment_start, b.header);
        let new_lines: Vec<String> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| format!("# {l}"))
            .collect();
        self.lines.splice(start..header, new_lines);
        self.reparse();
    }

    pub fn remove_block(&mut self, idx: usize) {
        let (start, end) = (self.blocks[idx].comment_start, self.blocks[idx].end);
        self.lines.drain(start..end);
        while self.lines.last().map(|l| is_blank(l)).unwrap_or(false) {
            self.lines.pop();
        }
        self.reparse();
    }

    pub fn append_block(
        &mut self,
        patterns: &[String],
        directives: &[(String, String)],
        description: Option<&str>,
    ) {
        let indent = self.preferred_indent();
        if let Some(last) = self.lines.last() {
            if !is_blank(last) {
                self.lines.push(String::new());
            }
        }
        if let Some(text) = description {
            for l in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                self.lines.push(format!("# {l}"));
            }
        }
        let header = patterns
            .iter()
            .map(|p| quote_if_needed(p))
            .collect::<Vec<_>>()
            .join(" ");
        self.lines.push(format!("Host {header}"));
        for (k, v) in directives {
            self.lines
                .push(format!("{indent}{k} {}", quote_if_needed(v)));
        }
        self.trailing_newline = true;
        self.reparse();
    }

    /// 用原始文本整体替换一个块（不含块尾空行）。文本必须恰好是一个 Host 段。
    pub fn replace_block_raw(&mut self, idx: usize, raw: &str) -> Result<(), String> {
        let probe = Document::parse("", raw);
        if probe.blocks.len() != 1 || probe.blocks[0].kind != BlockKind::Host {
            return Err("文本必须且只能包含一个 Host 段".into());
        }
        if !probe.globals.is_empty() {
            return Err("Host 行之前不能有其他配置项".into());
        }
        if probe.blocks[0].patterns.is_empty() {
            return Err("Host 行缺少别名".into());
        }
        let mut new_lines = probe.lines;
        while new_lines.last().map(|l| is_blank(l)).unwrap_or(false) {
            new_lines.pop();
        }
        let b = &self.blocks[idx];
        let (start, end) = (b.comment_start, self.content_end(b));
        self.lines.splice(start..end, new_lines);
        self.reparse();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# 全局默认
ServerAliveInterval 30

Host prod-web
    HostName 10.0.0.1
    User root
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

# CODING 专用密钥 —— 单独吊销
Host e.coding.net
  HostName e.coding.net
  User git
  IdentityFile ~/.ssh/id_ed25519_coding


Host  weird = 1.2.3.4
	HostName=1.2.3.4   # 行尾注释
	Port 2222
Host *
    ServerAliveCountMax 3
"#;

    fn doc() -> Document {
        Document::parse("/tmp/config", SAMPLE)
    }

    #[test]
    fn roundtrip_is_lossless() {
        assert_eq!(doc().render(), SAMPLE);
        for raw in ["", "\n", "Host a", "Host a\n\n\n", "  # only comment\n"] {
            assert_eq!(Document::parse("", raw).render(), raw, "raw={raw:?}");
        }
    }

    #[test]
    fn every_directive_renders_to_its_line() {
        let d = doc();
        for b in &d.blocks {
            assert_eq!(b.header_directive.render(), d.lines[b.header]);
            for dir in &b.directives {
                assert_eq!(dir.render(), d.lines[dir.line]);
            }
        }
        for dir in &d.globals {
            assert_eq!(dir.render(), d.lines[dir.line]);
        }
    }

    #[test]
    fn structure() {
        let d = doc();
        assert_eq!(d.globals.len(), 1);
        assert_eq!(d.blocks.len(), 4);
        assert_eq!(d.blocks[0].patterns, vec!["prod-web"]);
        assert_eq!(d.blocks[0].directives.len(), 4);
        assert_eq!(d.blocks[1].patterns, vec!["e.coding.net"]);
        assert_eq!(d.block_description(1).as_deref(), Some("CODING 专用密钥 —— 单独吊销"));
        assert_eq!(d.block_description(0), None);
        assert_eq!(d.blocks[2].patterns, vec!["weird", "=", "1.2.3.4"]);
        let hn = &d.blocks[2].directives[0];
        assert_eq!((hn.key.as_str(), hn.sep.as_str(), hn.value.as_str()), ("HostName", "=", "1.2.3.4"));
        assert_eq!(hn.comment, "   # 行尾注释");
        assert_eq!(d.blocks[3].patterns, vec!["*"]);
        assert_eq!(d.block_raw(0), "Host prod-web\n    HostName 10.0.0.1\n    User root\n    IdentityFile ~/.ssh/id_ed25519\n    IdentitiesOnly yes");
    }

    #[test]
    fn set_directive_replaces_in_place_and_keeps_comment() {
        let mut d = doc();
        d.set_directive(2, "hostname", &["9.9.9.9".into()]);
        assert_eq!(d.lines[d.blocks[2].header + 1], "\tHostName=9.9.9.9   # 行尾注释");
    }

    #[test]
    fn set_directive_inserts_with_block_indent() {
        let mut d = doc();
        d.set_directive(1, "Port", &["443".into()]);
        let b = &d.blocks[1];
        assert_eq!(d.lines[b.directives.last().unwrap().line], "  Port 443");
        assert_eq!(b.directives.len(), 4);
        // 其它块不受影响
        assert_eq!(d.blocks[0].directives.len(), 4);
        assert!(d.render().contains("\n  Port 443\n\n\nHost  weird"));
    }

    #[test]
    fn set_directive_multi_value_grow_and_shrink() {
        let mut d = doc();
        d.set_directive(0, "IdentityFile", &["~/.ssh/a".into(), "~/.ssh/b".into()]);
        let keys: Vec<String> = d.blocks[0].directives.iter().map(|x| format!("{} {}", x.key, x.value)).collect();
        assert_eq!(keys, vec!["HostName 10.0.0.1", "User root", "IdentityFile ~/.ssh/a", "IdentityFile ~/.ssh/b", "IdentitiesOnly yes"]);
        d.set_directive(0, "IdentityFile", &[]);
        let keys: Vec<&str> = d.blocks[0].directives.iter().map(|x| x.key.as_str()).collect();
        assert_eq!(keys, vec!["HostName", "User", "IdentitiesOnly"]);
    }

    #[test]
    fn set_directive_on_empty_block() {
        let mut d = Document::parse("", "Host a\n");
        d.set_directive(0, "HostName", &["h".into()]);
        assert_eq!(d.render(), "Host a\n    HostName h\n");
    }

    #[test]
    fn rename_and_description() {
        let mut d = doc();
        d.set_patterns(2, &["fixed".into()]);
        assert_eq!(d.lines[d.blocks[2].header], "Host  fixed");
        d.set_description(2, "第一行\n第二行");
        assert_eq!(d.block_raw(2), "# 第一行\n# 第二行\nHost  fixed\n\tHostName=1.2.3.4   # 行尾注释\n\tPort 2222");
        d.set_description(2, "");
        assert_eq!(d.block_raw(2), "Host  fixed\n\tHostName=1.2.3.4   # 行尾注释\n\tPort 2222");
        d.set_description(1, "");
        assert_eq!(d.block_description(1), None);
    }

    #[test]
    fn remove_block_keeps_neighbours_and_spacing() {
        let mut d = doc();
        d.remove_block(1);
        let expected = "# 全局默认\nServerAliveInterval 30\n\nHost prod-web\n    HostName 10.0.0.1\n    User root\n    IdentityFile ~/.ssh/id_ed25519\n    IdentitiesOnly yes\n\nHost  weird = 1.2.3.4\n\tHostName=1.2.3.4   # 行尾注释\n\tPort 2222\nHost *\n    ServerAliveCountMax 3\n";
        assert_eq!(d.render(), expected);
        d.remove_block(2);
        assert!(d.render().ends_with("\tPort 2222\n"));
    }

    #[test]
    fn append_block_uses_file_indent() {
        let mut d = Document::parse("", "Host a\n  HostName x\n");
        d.append_block(
            &["b".into()],
            &[("HostName".into(), "1.1.1.1".into()), ("IdentityFile".into(), "~/my keys/k".into())],
            Some("备注"),
        );
        assert_eq!(d.render(), "Host a\n  HostName x\n\n# 备注\nHost b\n  HostName 1.1.1.1\n  IdentityFile \"~/my keys/k\"\n");
        let mut e = Document::parse("", "");
        e.append_block(&["only".into()], &[("User".into(), "root".into())], None);
        assert_eq!(e.render(), "Host only\n    User root\n");
    }

    #[test]
    fn replace_block_raw_validates_and_splices() {
        let mut d = doc();
        assert!(d.replace_block_raw(0, "HostName x").is_err());
        assert!(d.replace_block_raw(0, "Host a\nHost b").is_err());
        d.replace_block_raw(0, "# new\nHost renamed\n    User admin\n\n\n").unwrap();
        assert_eq!(d.blocks[0].patterns, vec!["renamed"]);
        assert!(d.render().contains("# new\nHost renamed\n    User admin\n\n# CODING"));
    }

    #[test]
    fn quoting_helpers() {
        assert_eq!(unquote("\"a b\""), "a b");
        assert_eq!(unquote("plain"), "plain");
        assert_eq!(quote_if_needed("a b"), "\"a b\"");
        assert_eq!(quote_if_needed("\"a b\""), "\"a b\"");
        assert_eq!(quote_if_needed("ab"), "ab");
        assert_eq!(comment_start("a#b #c"), 4);
        assert_eq!(comment_start("\"a #b\" #c"), 7);
    }
}
