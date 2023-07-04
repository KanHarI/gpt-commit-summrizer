import type { PayloadRepository } from "@actions/github/lib/interfaces";
import type { RestEndpointMethodTypes } from "@octokit/rest";
import axios from "axios";
import { writeFileSync } from "fs";
import { resolve } from "path";

import { endPRSummary, startPRSummary } from "./commitSummary";
import { octokit } from "./octokit";
import { openai } from "./openAi";
import { summarizeCommitsToPr } from "./summarizer";
import { MAX_AI_QUERY_LENGTH, predict } from "./vertexAi";

const Personalities = [
  "Darth Vader",
  "Yoda",
  "A known politician",
  "A known celebrity",
  "A known historical figure",
  "A known fictional character",
  "A known anime character",
];

const OPEN_AI_PROMPT = `You are an expert writer, and you are trying to prepare the release notes.
You went over every Pull Request and Commit that is part of the release.
For some of these, there was an error in the Pull Request summary, or in the Commit summary.
Take into account that the Pull Requests summaries are written by an AI model.
Please summarize the release. Write your response in bullet points, starting each bullet point with a \`*\`.
Use the summary from the previous release as a starting point for the release notes.
Do not repeat the Pull Request summaries or the Commit summaries.
Do not repeat the previous release notes.
Do not repeat any bullet point more than once.
Your public is the marketing team and the users of the project, and they are not programmers.
Ensure that the release notes are easy to understand and they are written in a way that is appealing to the public.
Write it in the style of ${
  Personalities[Math.floor(Math.random() * Personalities.length) - 1]
}.
`;

const autogeneratedHeader = `###### Release Summary ######`;
const autogeneratedFooter = `###### End of Release Summary ######`;

export async function summarizeRelease(
  release: RestEndpointMethodTypes["repos"]["getRelease"]["response"]["data"],
  repository: PayloadRepository,
  updateRelease: boolean = false,
  generateImage: boolean = false,
  ignoredFiles: string = "",
  srcFiles: string = "",
  createFileComments: boolean = false,
  outputAsComment: boolean = false,
  replaceGeneratedNotes: boolean = false
): Promise<string> {
  // Remove the current release autogenerated summary
  let currentReleaseSummary = release.body || "";
  const regex = new RegExp(
    `${autogeneratedHeader}(.*)${autogeneratedFooter}`,
    "s"
  );
  const match = regex.exec(currentReleaseSummary);
  if (match) {
    if (!replaceGeneratedNotes) {
      console.log(
        "The release notes already contain an autogenerated summary. Skipping."
      );
      return match[1];
    }
    console.log("Replacing the current autogenerated summary");
    currentReleaseSummary = currentReleaseSummary.replace(match[0], "");
  }
  const releaseNotes = await octokit.repos.generateReleaseNotes({
    owner: repository.owner.login,
    repo: repository.name,
    tag_name: release.tag_name,
  });
  console.log(`Release notes:\n${releaseNotes.data.body}`);
  const compareUrl = releaseNotes.data.body.match(
    /\*\*Full Changelog\*\*: https:\/\/[^\s]+\/compare\/(.+)\.\.\.(.+)$/
  );
  const previousTag = compareUrl && compareUrl.length > 1 && compareUrl[1];
  let previousSummary = "";
  if (previousTag) {
    const previousRelease = await octokit.repos.getReleaseByTag({
      owner: repository.owner.login,
      repo: repository.name,
      tag: previousTag,
    });
    previousSummary = `THE PREVIOUS SUMMARY: \n\`\`\`\n${previousRelease.data.body}\n\`\`\`\n`;
  }

  // Get the PRs from the release notes
  const pullRequests = releaseNotes.data.body
    .split("\n")
    .map((line) => {
      const match = line.match(/https:\/\/[^\s]+\/pull\/(\d+)$/);
      if (match !== null && match.length > 1) {
        return [parseInt(match[1]), line];
      }
      return [0, ""];
    })
    .filter((pr) => !!pr && !!pr[0]);

  // Aggregate the generated PR summaries
  const pullRequestSummaries: string[] = [];
  for (const pullRequest of pullRequests) {
    const summary = await getOpenAISummaryForPullRequest(
      pullRequest[0] as number,
      repository,
      ignoredFiles,
      srcFiles,
      createFileComments,
      outputAsComment
    );
    pullRequestSummaries.push(
      `Summary for PR #${pullRequest[0]}:\nTitle: ${pullRequest[1]}\n${summary}`
    );
  }

  const openAIPrompt = `${OPEN_AI_PROMPT}\n\nTHE PR SUMMARIES:\n\`\`\`\n${pullRequestSummaries.join(
    "\n"
  )}\n\`\`\`\n\n${previousSummary}\n
  Reminder - write only the most important points. No more than a few bullet points.
  THE RELEASE SUMMARY:\n`;
  console.log(`AI for Release summary prompt:\n${openAIPrompt}`);

  if (openAIPrompt.length > MAX_AI_QUERY_LENGTH) {
    return "Error: couldn't generate summary. Release too big";
  }

  let result = await predict(openAIPrompt);
  if (!result) {
    throw new Error("Error: empty result from AI");
  }
  console.log(`AI for Release summary result:\n${result}`);
  if (generateImage) {
    const image = await generateImageFromSummary(result);
    // try delete the image
    for (const asset of release.assets) {
      if (asset.name === "release_summary.png") {
        // delete the asset
        await octokit.repos.deleteReleaseAsset({
          owner: repository.owner.login,
          repo: repository.name,
          asset_id: asset.id,
        });
      }
    }
    // upload image
    const imageUrl = await octokit.request({
      method: "POST",
      url: release.upload_url,
      headers: {
        "content-type": "image/png",
      },
      name: "release_summary.png",
      data: image,
      label: "release summary",
    });
    result = `${result}\n\n![Release Summary](${imageUrl.data.browser_download_url})`;
  }
  // update release
  if (updateRelease) {
    // Add the PR summaries to the release notes
    await octokit.repos.updateRelease({
      owner: repository.owner.login,
      repo: repository.name,
      release_id: release.id,
      body: `${currentReleaseSummary}\n\n${autogeneratedHeader}\n\n\n${result}\n\n\n${autogeneratedFooter}`,
    });
  }
  return result;
}

async function getOpenAISummaryForPullRequest(
  number: number,
  repository: PayloadRepository,
  ignoredFiles: string = "",
  srcFiles: string = "",
  createFileComments: boolean = false,
  outputAsComment: boolean = false
): Promise<string> {
  // See if the PR has an autogenerated summary, otherwise generate one
  const pullRequest = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  const descriptionText = pullRequest.data.body || "";
  // Match the body with the autogenerated headers
  const regex = new RegExp(`${startPRSummary}(.*)${endPRSummary}`, "s");
  const match = regex.exec(descriptionText);
  if (match) {
    return match[1];
  } else {
    // Generate a summary
    return await summarizeCommitsToPr(
      number,
      repository,
      ignoredFiles,
      srcFiles,
      createFileComments,
      outputAsComment
    );
  }
}

const IMAGE_OPEN_AI_PROMPT = `You are an expert AI, and you are trying to prepare a query to generate an image from the release notes.
Take into account that the Release notes are written by an AI model.
Please create a brief prompt to generate an image by an AI model.
The prompt should be in the style of:
"An AI model is trying to generate an image from the release notes of a repository. The release notes are written by an AI model."
The prompt should not be longer than 500 characters.
The prompt should be in one phrase.
Ensure that the prompt reflects an image description, and not a text description, of the release notes.
Ensure that the prompt focuses on the most important points of the release notes.
Ensure that the prompt doesn't have technical details, and is easy to understand.
Ensure that the prompt is based around the figure of the program the repository is about, and how it has improved with the last release.
Ensure that the prompt describes a scene that is easy to imagine and drawable.
The prompt needs to be focused around the personality ${
  Personalities[Math.floor(Math.random() * Personalities.length) - 1]
} using the released software.
`;

async function generateImageFromSummary(result: string): Promise<Buffer> {
  console.log(`Generating image from summary`);
  const releaseNotesSummary = await predict(
    `${IMAGE_OPEN_AI_PROMPT}\nTHE RELEASE NOTES:\n`,
    result,
    `\n\nTHE IMAGE QUERY:\n`
  );
  if (!releaseNotesSummary) {
    throw new Error("Error: empty result from AI");
  }
  console.log(`AI image prompt :\n${releaseNotesSummary}`);
  const response = await openai.createImage({
    prompt: `${releaseNotesSummary}. No text. Style of ${
      Personalities[Math.floor(Math.random() * Personalities.length) - 1]
    }`,
  });
  if (!response) {
    throw new Error("Error: empty result from AI");
  }
  // Download the image locally
  const url = response.data.data[0].url as string;
  console.log(`Image url: ${url}`);
  if (!url) {
    throw new Error("Error: empty result from AI");
  }
  const file = resolve(__dirname, "release_summary.png");
  const res = await axios.get(url, { responseType: "arraybuffer" });
  writeFileSync(file, res.data);
  return res.data;
}
