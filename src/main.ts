import * as fs from 'fs'
import {Octokit} from '@octokit/core'
import {Endpoints} from '@octokit/types'
import * as core from '@actions/core'
import * as github from '@actions/github'
import * as glob from 'glob'

type RepoAssetsResp = Endpoints['GET /repos/:owner/:repo/releases/:release_id/assets']['response']['data']
type GetReleaseResp = Endpoints['GET /repos/:owner/:repo/releases/:release_id']['response']['data']
type UploadAssetResp = Endpoints['POST /repos/:owner/:repo/releases/:release_id/assets{?name,label}']['response']

async function upload_to_release(
  release_id: string,
  file: string,
  asset_name: string,
  overwrite: boolean,
  octokit: Octokit
): Promise<undefined | string> {
  const stat = fs.statSync(file)
  if (!stat.isFile()) {
    core.debug(`Skipping ${file}, since its not a file`)
    return
  }
  const file_size = stat.size
  const file_bytes = fs.readFileSync(file)

  // Check for duplicates.
  const assets: RepoAssetsResp = await octokit.paginate(
    octokit.repos.listReleaseAssets,
    {
      ...repo(),
      release_id: release_id
    }
  )
  const duplicate_asset = assets.find(a => a.name === asset_name)
  if (duplicate_asset !== undefined) {
    if (overwrite) {
      core.debug(
        `An asset called ${asset_name} already exists in release so we'll overwrite it.`
      )
      await octokit.repos.deleteReleaseAsset({
        ...repo(),
        asset_id: duplicate_asset.id
      })
    } else {
      core.setFailed(`An asset called ${asset_name} already exists.`)
      return duplicate_asset.browser_download_url
    }
  } else {
    core.debug(
      `No pre-existing asset called ${asset_name} found in release. All good.`
    )
  }

  const release_info: GetReleaseResp = await octokit.repos.getRelease({
    release_id: release_id
  })

  core.debug(`Uploading ${file} to ${asset_name} in release.`)
  const uploaded_asset: UploadAssetResp = await octokit.repos.uploadReleaseAsset(
    {
      url: release_info.upload_url,
      name: asset_name,
      data: file_bytes,
      headers: {
        'content-type': 'binary/octet-stream',
        'content-length': file_size
      }
    }
  )
  return uploaded_asset.data.browser_download_url
}

function repo(): {owner: string; repo: string} {
  const repo_name = core.getInput('repo_name')
  // If we're not targeting a foreign repository, we can just return immediately and don't have to do extra work.
  if (!repo_name) {
    return github.context.repo
  }
  const owner = repo_name.substr(0, repo_name.indexOf('/'))
  if (!owner) {
    throw new Error(`Could not extract 'owner' from 'repo_name': ${repo_name}.`)
  }
  const repo = repo_name.substr(repo_name.indexOf('/') + 1)
  if (!repo) {
    throw new Error(`Could not extract 'repo' from 'repo_name': ${repo_name}.`)
  }
  return {
    owner,
    repo
  }
}

async function run(): Promise<void> {
  try {
    // Get the inputs from the workflow file: https://github.com/actions/toolkit/tree/master/packages/core#inputsoutputs
    const token = core.getInput('repo_token', {required: true})
    const file = core.getInput('file', {required: true})
    const asset_name = core.getInput('asset_name', {required: true})
    const release_id = core.getInput('release_id', {required: true})

    const file_glob = core.getInput('file_glob') == 'true' ? true : false
    const overwrite = core.getInput('overwrite') == 'true' ? true : false

    const octokit: Octokit = github.getOctokit(token)

    if (file_glob) {
      const files = glob.sync(file)
      if (files.length > 0) {
        for (const file of files) {
          const asset_download_url = await upload_to_release(
            release_id,
            file,
            asset_name,
            overwrite,
            octokit
          )
          core.setOutput('browser_download_url', asset_download_url)
        }
      } else {
        core.setFailed('No files matching the glob pattern found.')
      }
    } else {
      const asset_download_url = await upload_to_release(
        release_id,
        file,
        asset_name,
        overwrite,
        octokit
      )
      core.setOutput('browser_download_url', asset_download_url)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
