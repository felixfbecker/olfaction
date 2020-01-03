package de.unibremen.informatik.st.olfaction;

import de.unibremen.informatik.st.libvcs4j.Revision;
import de.unibremen.informatik.st.libvcs4j.RevisionRange;
import de.unibremen.informatik.st.libvcs4j.VCSEngine;
import de.unibremen.informatik.st.libvcs4j.VCSEngineBuilder;
import de.unibremen.informatik.st.libvcs4j.mapping.Mappable;
import de.unibremen.informatik.st.libvcs4j.mapping.Mapping;
import de.unibremen.informatik.st.libvcs4j.mapping.Mapping.Result;
import de.unibremen.informatik.st.libvcs4j.pmd.PMDRunner;
import de.unibremen.informatik.st.libvcs4j.pmd.PMDViolation;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.entity.StringEntity;
import org.apache.http.impl.client.HttpClientBuilder;
import org.json.simple.JSONObject;

import java.io.IOException;
import java.util.List;
import java.util.Optional;

public class Seed {

  public static void main(String[] args) throws IOException {
    VCSEngine engine = VCSEngineBuilder.ofGit("/Users/felix/git/lanterna").build();

    PMDRunner pmd = new PMDRunner();
    Mapping<String> mapping = new Mapping<>();
    for (RevisionRange range : engine) {
      Revision revision = range.getRevision();
      List<PMDViolation> violations = pmd.run(revision).getViolationsOf(revision.getId());
      Result<String> result = mapping.map(violations, range);
      for (Mappable<String> predecessor : result.getFrom()) {
        // Process mappables...
        System.out.println("Type:" + predecessor.getMetadata().get());
        System.out.println("Position:" + predecessor.getRanges());
        Optional<Mappable<String>> successor = result.getSuccessor(predecessor);

        // Create put request with JSON content.
        HttpPost request = new HttpPost();
        String query = String.join("\n",
            "mutation AddCodeSmells($repo: String!, $commit: String!, $codeSmells: [CodeSmellInput!]!) {",
            "  addCodeSmells(codeSmells: $codeSmells) {", "    id", "  }", "}");
        JSONObject jsonObject = new JSONObject();
        StringEntity entity = new StringEntity(jsonObject.toString());
        entity.setContentType("application/json");

        request.setEntity(entity);
        // Send request.
        final CloseableHttpResponse response = HttpClientBuilder.create().build().execute(request);
        System.out.println(
            "Response:" + response.getStatusLine().getStatusCode() + " " + response.getStatusLine().getReasonPhrase());
      }
    }
  }
}
